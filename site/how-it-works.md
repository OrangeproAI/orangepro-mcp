---
title: How targeted mutation proof works
---
# How targeted mutation proof works

1. The graph picks where to spend attention: behaviors affected by a change, ranked by what a break could cost.
2. For a chosen test, OrangePro breaks the target function in an isolated copy.
3. It runs the test on the original and on the broken copy.
4. If the test passes on the original and fails on the broken copy, that behavior is Proven for that test. If it still passes, it is Not proven, and that is a finding.
5. Generated or written tests close the gap; execution turns the result into proof.

Honest limits: proof covers only the languages and runners listed in the README; mocks-only tests do not count; the result says what one test did when one function was broken.
Where it fits: the merged base build, after merge and before release. Not a PR gate, not a release gate.
