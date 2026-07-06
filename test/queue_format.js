import assert from 'node:assert/strict';

import {
  emptyQueueDocument,
  isQueueEntryActive,
  queueEntryKey,
} from '../src/queue_format.js';

function main() {
  const document = {
    mirrors: [],
    entries: [
      {artist: 'A', title: 'One', url: 'https://example.com/1', disabled: false},
      {artist: 'B', title: 'Two', url: 'https://example.com/2', disabled: true},
    ],
  };

  assert.equal(
    queueEntryKey({artist: 'A', title: 'One', url: 'https://example.com/1'}),
    queueEntryKey({artist: ' A ', title: 'One', url: 'https://example.com/1'}),
  );
  assert.equal(
    isQueueEntryActive(document, {
      artist: 'A',
      title: 'One',
      url: 'https://example.com/1',
    }),
    true,
  );
  assert.equal(
    isQueueEntryActive(document, {
      artist: 'B',
      title: 'Two',
      url: 'https://example.com/2',
    }),
    false,
  );
  assert.equal(
    isQueueEntryActive(emptyQueueDocument(), {
      artist: 'A',
      title: 'One',
      url: 'https://example.com/1',
    }),
    false,
  );

  console.log('queue_format tests passed');
}

main();
