# BM04 acceptance evidence validator

Run from the repository root with Node.js 24.

```sh
node --test be/scripts/bm04-evidence/validate.test.mjs
node be/scripts/bm04-evidence/validate.mjs \
  --sha "$(git rev-parse HEAD)" \
  --manifest /path/to/evidence/manifest.json \
  --out /tmp/mealtrace-bm04
```

Use `--sha` with the full commit actually being reviewed. Omit `--manifest` to audit the inventory and list open evidence. Use `--mapping` to supply the workflow owners' reviewed case-to-test mappings. Exit codes are `0` for GO, `1` for a valid NO-GO report and `2` for invalid input. Evidence errors appear in both reports. Invalid arguments or mappings produce a diagnostic before report generation.

## Ledger

[mapping.json](mapping.json) preserves P3 §7's 30 case descriptions and ownership, including the 24 CI designations, and P3 §8's 12 staging demo IDs. The 22 unresolved CI mappings need owner confirmation or additional tests. Tests listed under unresolved or manual mappings are investigative leads. W04-01 and W04-02 have mapped test identities based on inspection of the amendment tests. Their execution status comes from supplied artifacts.

The mandatory main-path flags use the case IDs referenced in the six P3 §8 main stories. The project gives no separate per-ID mandatory flag list, so review this interpretation with the workflow owners when confirming the mapping. A GO requires all 30 cases to have execution evidence, all designated CI cases to verify, at least 95% of executed cases to pass, all mandatory main paths to verify, all 12 staging demos to verify, and a complete runtime defect disposition with zero open Critical or High. The reports keep case counts and raw CI runner totals separate. BM02 design findings and reviewer release authorization remain separate from this automated gate.

## Assemble an evidence directory

Use paths relative to the manifest directory. Save actual result files, deploy and device logs, demo records and tracker snapshots in the same evidence directory. Calculate the SHA-256 over the unchanged bytes of each referenced file, for example with `sha256sum`. Each JSON entrypoint below uses `"version": 1`, `"sample": false` and the same full `"releaseSha"` supplied to the CLI. Replace the angle-bracket placeholders with collected metadata.

### Manifest and CI provenance

```json
{
  "version": 1,
  "sample": false,
  "releaseSha": "<full release commit>",
  "runs": [{ "path": "backend.trx", "provenance": "backend-run.json" }],
  "observations": "observations.json",
  "runtimeDefects": "runtime-defects.json"
}
```

Each CI job has one selected artifact and attempt. Its separate provenance file has the common fields above plus:

| Field | Value |
| --- | --- |
| `job` | Job key used in the mapping. The current Backend CI key is `backend`. |
| `runId`, `runAttempt` | Run identifier as a string and attempt as a positive integer from CI metadata. |
| `source` | Link identifying the originating CI run or job. |
| `format` | `trx` or `ci-results-v1`. |
| `artifactSha256` | Lowercase SHA-256 of the supplied artifact. |

For the existing Backend CI workflow, download `backend.trx` from the selected run's `backend-test-results` artifact. Record the SHA of the actual checked-out commit in the provenance file using the CI job's checkout details. A pull request run can test a merge commit, so check the checkout SHA before selecting the run. Save the provenance and digest together when collecting the artifact. The validator checks that binding and the file's bytes offline. The collector is responsible for the authenticity of the CI metadata, stage deployment records and reviewer observations.

TRX identity is the exact `TestMethod.className + "." + TestMethod.name` associated with the result's `testId`. Use the completed VSTest artifact from this workflow. The TRX reader supports ordinary flat `UnitTestResult` rows and rejects unsupported result structures. Multiple parameter rows with the same identity contribute to a single case. Every mapped identity must have results and every matching row must pass. Failure, interruption and skip take precedence over pass. Select a replacement attempt as a whole when rerunning a job.

For Vitest, Flutter or another runner, normalize the actual machine-readable reporter output to the following adapter JSON. Preserve exact per-test identities, every outcome and every parameter row emitted by the job. Match the job key and identity to the reviewed mapping. The provenance digest must cover this JSON. Preserve the original reporter output with the run for review.

```json
{
  "version": 1,
  "results": [{ "identity": "<repo path> :: <full test name>", "status": "PASSED" }]
}
```

The adapter accepts `PASSED`, `FAILED`, `SKIPPED` and `BLOCKED`. Map pending or skipped tests to `SKIPPED` and aborted or inconclusive tests to `BLOCKED`. A confirmed mapping requires exact identities whose combined assertions cover the whole case.

### Observations and runtime defects

`observations.json` contains the common fields and an `entries` array. Each entry includes:

- `id` for a non-CI case or demo from the ledger, `kind` of `manual`, `device` or `demo`, and the observed `status` using the adapter outcomes.
- `observedBy`, `details` describing the execution and result, and `environment`. Use `staging` for demos and include the seeded replay and deployment evidence in their references.
- `device` with physical Android model and OS for device cases.
- `references` as an array of one or more `{"path":"relative-file","sha256":"<lowercase SHA-256>"}` records. Reference logs or recordings that show the case or scenario ran on the specified release.

`runtime-defects.json` contains the common fields, a boolean `complete`, `reviewedBy`, an array of `defects` and `references` to the tracker export and disposition evidence. A defect row has `id`, `severity` (`CRITICAL` or `HIGH`), `disposition` (`OPEN` or `RESOLVED`) and `details`. A complete, reviewed disposition with an empty array can support a zero-defect claim when its reference shows that the review found zero. Missing disposition stays open.

Optional count claims on the manifest are checked against the result rows. Supported fields are `ledger` (`unique`, `ci`, `ciPassed`, `passed`, `failed`, `skipped`, `executed`), `demo` (`main`, `exception`), `openCritical` and `openHigh`.

## Run the synthetic example

```sh
node be/scripts/bm04-evidence/validate.mjs \
  --sha 1111111111111111111111111111111111111111 --sample \
  --manifest be/scripts/bm04-evidence/fixtures/SAMPLE-manifest.json \
  --out /tmp/mealtrace-bm04-sample
```

This returns `1` and writes `SAMPLE-bm04.json` and `SAMPLE-bm04.md`. Only the synthetic example uses `--sample`.
