# Redirectory

> An Artifactory impostor for Conan that redirects to GitHub.

Redirectory is a server for [Conan] packages,
or a [_remote_][remotes] in Conan parlance.
From the perspective of a Conan client,
it is meant to be a drop-in replacement for [Artifactory].

Redirectory works by using GitHub [releases] as free public storage.
Uploading recipes and packages creates releases in a GitHub repository
based on the package reference and attaches files as assets[^2].
Every [revision] of a recipe or package gets its own release[^3].
Installing recipes and packages
looks up those releases and downloads their assets.

[^2]: This effectively means that files must be under 2 GB,
which might be a problem for extremely large binary packages,
but even a debug build of Boost clocks in at only 70 MB compressed.

[^3]: If you use Conan with revisions disabled,
then it effectively gives every recipe and package
exactly one revision with ID `0`.

Redirectory packages are clearly identified by their references.
Conan package references have the form `${name}/${version}@${user}/${channel}`.
By default, Redirectory packages have the user `github`
and are hosted at the GitHub repository `${name}` owned by `${channel}`.
For example, the package `cupcake/0.2.0@github/thejohnfreeman`
is hosted at the GitHub repository [`thejohnfreeman/cupcake`][1].

If you run your own server,
you can instead keep all packages in one repository
by setting `REDIRECTORY_GITHUB_REPOSITORY` to its `owner/name`.
This option requires Conan 2 and accepts references such as `cupcake/0.2.0`.
Leaving the setting empty preserves the original mapping.
Changing it does not move existing packages.

In the spirit of [PyPI], [NPM], [crates.io], and [Hackage],
I run a **free public Redirectory server** at https://conan.jfreeman.dev
to let open source developers like myself publish and share packages
without the gatekeeping of [Conan Center][][^5]
but free from the responsibility of operating a package server[^4].

[^4]: If you do not trust my server with your PAT,
you can [run your own Redirectory server](#host) with Docker or Scaleway.

[^5]: I love that Conan Center provides a convenient default registry
of curated recipes for most widely-used packages,
but I still want a frictionless package registry
like I enjoy in other language ecosystems.

Redirectory has been tested with Conan 1.x,
with and without revisions enabled,
and Conan 2.x, which always has revisions enabled.


## Authentication

Both uploading and downloading require the server to
interact with the GitHub API.
Downloading requires only read permissions,
and the server supplies a shared token to serve downloads
by unauthenticated users.
GitHub [rate limits][3] tokens to 5000 requests per hour.
The number of requests depends on the repository mode
and whether your client has revisions enabled.

If you find the server cannot serve your downloads
because the shared token is exhausted,
then you can either wait for its limit to reset
or you can supply your own [GitHub Personal Access Token (PAT)][PAT].
If you never upload packages,
then that token only needs the bare minimum read-only permissions.
If you want to publish packages,
then you _must_ authenticate with that token
and it needs to have write permissions
for the GitHub repositories hosting your releases.

To create a PAT, navigate to your [token settings][2]
and click "Generate new token".
Give your token a name.
If you want to publish packages through Redirectory,
then under "Permissions" -> "Repository permissions",
make sure it has read-write permissions for "Contents"
(which will automatically include read-only permissions for "Metadata").
Otherwise, you can choose a "Public Repositories (read-only)" token
under "Repository access".
You can always change these decisions later by generating a new token
and revoking the old one.


## Configure

First, add the Redirectory server you want to use.
My free public server is https://conan.jfreeman.dev.

```
conan remote add redirectory ${url}
```

Second, you can optionally authenticate to the server using a
[GitHub Personal Access Token (PAT)][PAT]
(see [Authentication](#authentication)).
Redirectory does not store this token[^1].
It returns an encrypted session that expires after 30 minutes.
Your Conan client stores that session in your local Conan cache
and includes it with every authenticated request it sends to Redirectory.

[^1]: To keep my costs down, the Redirectory server doesn't store _anything_.

Authenticate to Redirectory with your GitHub username
and enter the token at the password prompt:

```
conan user --remote redirectory ${owner}
```

For Conan 2, use `conan remote login redirectory ${owner}` instead.


## Consume

In the default mode, package references are of the form `${name}/${version}@github/${channel}`
where `${name}` matches the name of a repository on GitHub,
`${version}` is a tag in that repository,
and `${channel}` is the owner of that repository.

You can search for available package versions:

```
conan search --remote redirectory ${name}
```


## Publish

When you publish a package,
Redirectory will create a tag and a release for you if none exists.
In the default mode, it will add some metadata in an HTML comment
in the description of that release.
It is important that you never tamper with that comment.

The repository must be public and have at least one commit
before GitHub can create release tags.

To publish a package,
first export it to your local Conan cache
and then upload it to Redirectory.

```
conan export . github/${owner}
conan upload --remote redirectory ${name}/${version}@github/${owner}
```

After publishing a package,
its files will not be immediately available for installation.
You must wait for GitHub to percolate the asset state
across its load balancer.
In my experience, this can take up to 60 seconds.

In the default mode, if you want your package to be [discoverable][4]
through `conan search`,
then you'll need to add `redirectory` as a [topic] on your repository.


## Host

To run your own server, install Node 24 and Docker Compose.
Copy [.env.example](.env.example) to `.env`
and set `REDIRECTORY_GITHUB_READ_TOKEN` to a read-only GitHub token.
Then generate an encryption key and start the server:

```
npm run configure
docker compose up -d --build
```

Your server is now available at `http://127.0.0.1:9595`.
You can change the host port with `HOST_PORT`
and the application port with `PORT`.
You can also put the container behind your HTTPS reverse proxy.
Set `REDIRECTORY_PUBLIC_URL` to the external address for Conan 1 upload URLs.

Keep `.env` private and preserve the encryption key across updates.
The server does not need a database or persistent volume.
When upgrading from the original server,
move the shared read token from `oauth.json` to `.env`
and log in again. Your existing packages work as they are.
Upload URLs no longer contain plaintext GitHub tokens.
The default upload limit is 1 GiB per file.

### Scaleway

To use Scaleway instead, install OpenTofu 1.8 or newer.
Publish a public `linux/amd64` image using the **Validate** workflow
with an image tag, or your own build pipeline.
Set `REDIRECTORY_IMAGE` in `.env` to the published image digest,
and fill in your Scaleway credentials and project ID.
To create a separate project, leave `SCW_DEFAULT_PROJECT_ID` empty
and set `REDIRECTORY_CREATE_PROJECT=true`,
`SCW_DEFAULT_ORGANIZATION_ID` and `REDIRECTORY_PROJECT_NAME`.

```
npm run deploy
```

The deployment uses the same container and prints its HTTPS address when ready.
By default, it uses 140 mCPU and 256 MB,
and scales from zero to one instances.
The first request after an idle period may take longer while the server starts.

For your own subdomain, set `REDIRECTORY_DOMAIN`.
If you use Scaleway DNS, also set `REDIRECTORY_DNS_ZONE`.
Otherwise, add the CNAME printed by the deployment at your DNS provider
(with the proxy disabled if you use Cloudflare).
Scaleway issues and renews the HTTPS certificate.

Back up `.deploy/` too. It tracks the infrastructure for this checkout.
Use a separate checkout for each deployment.
To update, change the image digest and run `npm run deploy` again.
To remove the infrastructure, run `npm run destroy`.
This leaves your GitHub packages and externally managed DNS records intact.


[topic]: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics
[Conan]: https://conan.io/
[Artifactory]: https://jfrog.com/artifactory/
[remotes]: https://docs.conan.io/2/tutorial/conan_repositories/setting_up_conan_remotes.html
[releases]: https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
[PAT]: https://github.blog/2022-10-18-introducing-fine-grained-personal-access-tokens-for-github/
[PyPI]: https://pypi.org/
[NPM]: https://www.npmjs.com/
[crates.io]: https://crates.io/
[Hackage]: https://hackage.haskell.org/
[revision]: https://docs.conan.io/1/versioning/revisions.html
[Conan Center]: https://conan.io/center

[1]: https://github.com/thejohnfreeman/cupcake/releases
[2]: https://github.com/settings/tokens?type=beta
[3]: https://docs.github.com/en/rest/overview/resources-in-the-rest-api?apiVersion=2022-11-28#rate-limiting
[4]: https://github.com/topics/redirectory
