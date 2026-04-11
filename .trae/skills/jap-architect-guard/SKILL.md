---
name: "jap-architect-guard"
description: "Constrains JAP requirement elicitation and design outputs for consistency and non-duplication. Invoke when generating questionnaire, modeling, review, or detailing artifacts."
---

# JAP Architect Guard

Use this skill to enforce stable output quality in JAP Plus workflow.

## Invocation

Invoke when:
- generating requirement clarification questions
- generating modeling artifacts
- running cross-artifact review
- generating detailing deliverables

## Rules

1. Keep outputs schema-compliant only.
2. Avoid semantic duplicates in questions.
3. Prioritize boundary conditions and irreversible decisions.
4. Keep naming consistent across domain model, state machine, and API contract.
5. Ensure artifacts are mutually referential and conflict-free.

