import argparse
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--remote', required=True)
    parser.add_argument('--legacy-owner')
    parser.add_argument('--legacy-repository')
    parser.add_argument('--conan', default='conan')
    parser.add_argument('--conan1', action='store_true')
    parser.add_argument('--revisions', default='1', choices=['0', '1'])
    parser.add_argument('--allow-remote-writes', action='store_true', required=True)
    args = parser.parse_args()
    token = os.environ.get('REDIRECTORY_TEST_TOKEN')
    if not token:
        raise RuntimeError('Set REDIRECTORY_TEST_TOKEN for the disposable package repository')
    with tempfile.TemporaryDirectory(prefix='redirectory-e2e-') as temporary:
        base = Path(temporary)
        env = dict(os.environ, CONAN_HOME=str(base / 'cache'), CONAN_LOGIN_USERNAME_REDIRECTORY='test', CONAN_PASSWORD_REDIRECTORY=token)
        env.pop('REDIRECTORY_TEST_TOKEN', None)
        env['CONAN_USER_HOME'] = str(base / 'cache1')
        env['CONAN_REVISIONS_ENABLED'] = args.revisions
        def run(*command, cwd=base, retry=False, credentials=True):
            if command[0] == 'conan':
                command = (args.conan, *command[1:])
            current = dict(env)
            if not credentials:
                current.pop('CONAN_PASSWORD_REDIRECTORY', None)
                current.pop('CONAN_LOGIN_USERNAME_REDIRECTORY', None)
                current['CONAN_NON_INTERACTIVE'] = '1'
            for attempt in range(7 if retry else 1):
                result = subprocess.run(command, cwd=cwd, env=current, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                output = result.stdout.replace(token, '[REDACTED]')
                if result.returncode == 0 and not any(line.lstrip().startswith('ERROR:') for line in output.splitlines()):
                    print(output, end='')
                    return
                if not retry or attempt == 6:
                    print(output, end='')
                    raise RuntimeError(f'{command[0]} failed with exit code {result.returncode}')
                time.sleep(min(2 ** attempt, 16))
        run('conan', '--version')
        if args.conan1:
            run('conan', 'profile', 'new', 'default', '--detect')
            run('conan', 'profile', 'update', 'settings.compiler.libcxx=libstdc++11', 'default')
        else:
            run('conan', 'profile', 'detect')
        run('conan', 'remote', 'disable', 'conancenter')
        run('conan', 'remote', 'add', 'redirectory', args.remote)
        run('conan', *(['user', 'test', '-r', 'redirectory'] if args.conan1 else ['remote', 'login', 'redirectory', 'test']))
        suffix = uuid.uuid4().hex[:10]
        references = ([f'{args.legacy_repository}/0.1-{name}-{suffix}@github/{args.legacy_owner}' for name in ('alpha', 'beta')] if args.legacy_owner else [f'rd-smoke-{name}-{suffix}/1.0' for name in ('alpha', 'beta')])
        uploaded = []
        try:
            for reference in references:
                recipe = base / reference.split('@')[0].replace('/', '-')
                recipe.mkdir()
                (recipe / 'conanfile.py').write_text('''from conan import ConanFile
from conan.tools.cmake import CMake, cmake_layout

class Smoke(ConanFile):
    settings = "os", "compiler", "build_type", "arch"
    package_type = "static-library"
    exports_sources = "CMakeLists.txt", "answer.cpp", "answer.h"
    generators = "CMakeToolchain"
    def layout(self):
        cmake_layout(self)
    def build(self):
        cmake = CMake(self)
        cmake.configure()
        cmake.build()
    def package(self):
        CMake(self).install()
    def package_info(self):
        self.cpp_info.libs = ["answer"]
        self.cpp_info.set_property("cmake_file_name", "answer")
        self.cpp_info.set_property("cmake_target_name", "answer::answer")
''')
                (recipe / 'answer.h').write_text('int answer();\n')
                (recipe / 'answer.cpp').write_text('int answer() { return 42; }\n')
                (recipe / 'CMakeLists.txt').write_text('''cmake_minimum_required(VERSION 3.15)
project(answer LANGUAGES CXX)
add_library(answer STATIC answer.cpp)
install(TARGETS answer ARCHIVE DESTINATION lib)
install(FILES answer.h DESTINATION include)
''')
                name, version = reference.split('@')[0].split('/')
                if args.conan1:
                    run('conan', 'create', str(recipe), reference)
                else:
                    run('conan', 'create', str(recipe), '--name', name, '--version', version, *(['--user', 'github', '--channel', args.legacy_owner] if args.legacy_owner else []))
                uploaded.append(reference)
                run('conan', 'upload', reference, '-r', 'redirectory', ('--all' if args.conan1 else '--confirm'), *(['--confirm'] if args.conan1 else []), retry=True)
                run('conan', 'upload', reference, '-r', 'redirectory', ('--all' if args.conan1 else '--confirm'), *(['--confirm'] if args.conan1 else []), retry=True)
            if not args.legacy_owner:
                run('conan', 'list', f'rd-smoke-*-{suffix}/*#*:*#*', '-r', 'redirectory', retry=True)
            run('conan', *(['user', '--clean'] if args.conan1 else ['remote', 'logout', 'redirectory']))
            for reference in references:
                run('conan', 'remove', reference, '-f' if args.conan1 else '--confirm')
                consumer = base / ('consumer-' + reference.split('@')[0].replace('/', '-'))
                consumer.mkdir()
                (consumer / 'main.cpp').write_text('#include <answer.h>\nint main() { return answer() == 42 ? 0 : 1; }\n')
                (consumer / 'CMakeLists.txt').write_text('''cmake_minimum_required(VERSION 3.15)
project(consumer LANGUAGES CXX)
find_package(answer CONFIG REQUIRED)
add_executable(consumer main.cpp)
target_link_libraries(consumer PRIVATE answer::answer)
''')
                (consumer / 'conanfile.txt').write_text('[requires]\n' + reference + '\n[generators]\nCMakeDeps\nCMakeToolchain\n')
                run('conan', 'install', str(consumer), '-r', 'redirectory', '--build=never', '-if' if args.conan1 else '-of', str(consumer / 'build'), retry=True, credentials=False)
                run('cmake', '-S', str(consumer), '-B', str(consumer / 'build'), '-DCMAKE_TOOLCHAIN_FILE=conan_toolchain.cmake', '-DCMAKE_BUILD_TYPE=Release')
                run('cmake', '--build', str(consumer / 'build'), '--config', 'Release')
                executable = consumer / 'build' / ('Release/consumer.exe' if os.name == 'nt' else 'consumer')
                run(str(executable))
            request = urllib.request.Request(args.remote + '/v2/conans/denied/1/_/_/revisions/abc/files/conanfile.py', data=b'denied', method='PUT')
            try:
                urllib.request.urlopen(request)
                raise RuntimeError('Anonymous upload unexpectedly succeeded')
            except urllib.error.HTTPError as error:
                if error.code != 401:
                    raise
            print('PASS: two packages, repeated upload, anonymous clean-cache binary install and compiled consumers')
        finally:
            run('conan', *(['user', 'test', '-r', 'redirectory'] if args.conan1 else ['remote', 'login', 'redirectory', 'test']))
            failures = []
            for reference in uploaded:
                try:
                    run('conan', 'remove', reference, '-r', 'redirectory', '-f' if args.conan1 else '--confirm', retry=True)
                except RuntimeError:
                    failures.append(reference)
            if failures:
                raise RuntimeError('Remote cleanup failed for: ' + ', '.join(failures))


if __name__ == '__main__':
    main()
