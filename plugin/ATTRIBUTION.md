# Third-party skills bundled with this plugin

`plugin/skills/` contains 27 skills authored by **Matt Pocock**, taken from
<https://github.com/mattpocock/skills> and redistributed under the MIT License
(see [`LICENSE-mattpocock-skills`](./LICENSE-mattpocock-skills)).

- Upstream package: `mattpocock-skills` v1.3.1
- Author: Matt Pocock — <https://www.aihero.dev/s/skills-newsletter>
- License: MIT

## Why they are bundled

Two reasons, both deliberate:

1. **They travel with the plugin.** Skill discovery reads `<root>/<name>/SKILL.md`
   one level deep. These are shipped inside the package and served by this
   plugin's own `skill-filesystem` row (`cordis.patch.yml`), so every session in
   every project sees them without anyone copying files into a repository.
2. **They are the workflow engine.** The workbench derives a project's current
   stage from its artifacts and dispatches the matching skill, so the skill set
   is a runtime dependency, not a convenience.

## Layout note

The upstream tree is grouped as `skills/engineering/<name>/` and
`skills/productivity/<name>/`. Discovery would not see a skill two levels down,
so the vendored copy is **flattened** to `skills/<name>/` with each skill's
bundled resources (`references/`, `scripts/`, `assets/`) kept beside its
`SKILL.md`.

## Which skills the model can load directly

16 of the 27 set `disable-model-invocation: true`, which keeps them out of the
`skill` tool's catalog; they are reachable only through an explicit `/name`
gesture or by reading `SKILL.md` directly. That set includes the workflow-gating
skills `to-spec`, `to-tickets`, `wayfinder`, `implement`, `handoff`, `triage` and
`setup-matt-pocock-skills` — which is why the workbench's dispatch prompts pass
an absolute `SKILL.md` path rather than relying on the tool.

## Updating

Re-run the vendoring step against a newer upstream revision, keeping the flatten
rule and this attribution file. Do not edit the skill bodies in place; keep local
adaptations in `plugin/skills-local/` (if ever added) so upstream diffs stay
readable.
