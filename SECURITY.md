# Security policy

ieee-xplore-mcp keeps an institutional proxy session (library cookies) and optional API keys on the user's machine, and fetches documents on the user's behalf. Problems in those areas matter most.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub security advisories: https://github.com/danieltyukov/ieee-mcp/security/advisories/new. Include the version (`ieee-xplore-mcp --version`), the operating system, the steps to reproduce and what an attacker could gain.

## Scope

In scope:

- The session file and browser profile under `~/.ieee-mcp`, their permissions, and any way the proxy session could reach another user, another process or the model.
- API keys or cookies appearing in tool output, error messages or logs.
- Cookie handling in the proxy client, for example sending proxy cookies to a host outside the proxy.
- Prompt injection paths where document or metadata text could make the server take an action the user did not ask for, such as downloading many papers or writing files elsewhere.
- The release pipeline.

Out of scope:

- Vulnerabilities in IEEE Xplore, OpenAlex, doi.org or a university's proxy or identity provider. Report those to their operators.
- Issues that require an attacker who already controls the user's OS account.

## What to expect

You should get an acknowledgement within seven days. Confirmed problems are fixed in a patch release and described in `CHANGELOG.md` and the advisory. Only the latest release receives fixes.
