
# freyr testing

The default test suite is local and focuses on the HTTP queue server.

```console
npm test
```

The queue-server test covers:

- root UI rendering
- queue list discovery
- list entry parsing
- path traversal rejection
- disabling a song by commenting its line
- deleting a song line
- invalid list mutation handling

Provider download fixture tests were removed along with the unused third-party providers.
