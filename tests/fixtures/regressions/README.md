# DBML regression inputs

These minimal, locally authored MIT inputs retain failures found while expanding the normalization tests. They are not copied upstream examples and have no compatibility status beyond their explicit expectations in `tests/dbml-rejections.test.ts`.

| Input | Origin | Expected result with the pinned parser |
| --- | --- | --- |
| [leading-dot-default.dbml](leading-dot-default.dbml) | Reduced from generated seed `0x5eed1234`, case 3; the same form also appeared under the other two fixed seeds | `DBML_SYNTAX`; `.125` is not accepted as a numeric default. The positive generated cases use `0.125` without changing the exact spelling during normalization. |
| [multiline-reference-settings.dbml](multiline-reference-settings.dbml) | Reduced from the composite/circular action matrix | `DBML_SYNTAX`; a standalone composite reference's settings must remain on its relationship line in this parser profile. |

Parser updates must review these failures explicitly. Do not automatically replace diagnostics or treat a newly accepted syntax form as evidence of faithful normalization. Retain a reduced input and add independent assertions when a newly discovered failure changes the supported profile.
