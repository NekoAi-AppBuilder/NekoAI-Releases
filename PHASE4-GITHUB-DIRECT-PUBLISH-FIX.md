# Phase 4 — Direct GitHub Publish Fix (v0.4.50)

## Problem
Windows Git Credential Manager could intercept an authenticated Git operation and open its own "Connect to GitHub" UI, causing a second login during Publish/Push.

## Fix
All GitHub-authenticated Git operations now:
- clear configured `credential.helper` for that invocation;
- set `credential.username=x-access-token`;
- set `GIT_ASKPASS` to the Neko temporary helper;
- set `GIT_ASKPASS_REQUIRE=force`;
- set `GIT_TERMINAL_PROMPT=0`;
- pass the token only through the child-process environment;
- remove the temporary helper after the operation.

## Expected behavior
Once the Neko GitHub session is connected, Clone, Publish, Fetch, Checkout and Commit + Push must execute without opening Git Credential Manager or requesting a second login.
