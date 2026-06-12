---
description: Reviews file and verifies it meets our test criteria
disable-model-invocation: true
argument-hint: 
---
Verify $0 has proper testing according to the following criteria

# Requirements
* File should have at least 90% coverage
* Tests should have positive and negative tests (i.e. verify the test actually CAN break)
* Tests should be repeatable (if they create/delete/mutate data...that should be reset before the test runs)

# Aspirations
* Tests should be able to run in parallel as much as possible
