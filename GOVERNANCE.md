# Governance

What a Pull is open source, but responsibility is earned through demonstrated work rather
than granted in anticipation of it. This document explains the path from a first
contribution to subsystem ownership and the access boundaries at each step.

## Roles

### Contributor

Contributors improve the project through code, tests, documentation, design,
accessibility work, bug reports, or review. Anyone who follows
[`CONTRIBUTING.md`](./CONTRIBUTING.md) and the Code of Conduct may contribute. The role
carries no repository or infrastructure permissions.

### Reviewer

Reviewers are recurring contributors who have shown sound judgment, understand the
project's seven laws, and give specific, technically grounded feedback. They may review
an area without having write access or responsibility for merging it.

### Maintainer

Maintainers own the health of one or more subsystems. Examples include the web app and
frontend, the design system, Supabase and database work, the generation pipeline,
testing and tooling, or documentation.

Maintainership is based on evidence: several substantive contributions, useful reviews,
understanding of the subsystem's architecture and risks, and sustained participation.
There is no mechanical contribution count. Existing maintainers invite someone when
their demonstrated responsibility matches the role. Ownership is recorded in
`.github/CODEOWNERS` only after it exists in practice.

### Project lead and administrator

Jai Sharma ([`@JaiSharma7`](https://github.com/JaiSharma7)) is currently the sole
maintainer, project lead, and project administrator. The project lead resolves final
governance decisions, organization settings, releases, and sensitive operational access
until those responsibilities are explicitly delegated.

## Supabase and production access

Repository responsibility and production access are separate. Access is least-privilege,
time-appropriate, and never automatic because of a title.

| Role               | Supabase access                                                          |
| ------------------ | ------------------------------------------------------------------------ |
| Contributor        | Local Supabase stack only                                                |
| Reviewer           | Local Supabase stack only                                                |
| Backend maintainer | Potentially hosted project access, only when the responsibility needs it |
| Project admin      | Production secrets and administrative access                             |

Reviewers do not need hosted access to validate backend changes. Backend maintainers may
receive scoped hosted-project access when an ongoing operational responsibility requires
it; maintainership alone does not imply production secrets. Production credentials,
organization administration, secret rotation, billing, and destructive production
operations remain project-admin responsibilities unless explicitly delegated.

## Decisions and accountability

Most decisions should be made in public issues and pull requests, with the rationale
preserved beside the change. Architectural, security-sensitive, destructive, or
production-facing proposals should be discussed before implementation. Maintainers are
expected to explain decisions against the project's laws and verified behavior, not
appeal to role alone.

The project lead may appoint or remove reviewers and maintainers, change subsystem
boundaries, and delegate administrative duties. Those changes should be reflected here
and in `.github/CODEOWNERS` in the same pull request.
