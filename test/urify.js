import FreyrCore from '../src/freyr.js';

let corpus = [
  {
    url: 'https://www.youtube.com/watch?v=jBmhsV9NKPg',
    uri: 'youtube:track:jBmhsV9NKPg',
  },
  {
    url: 'https://youtu.be/jBmhsV9NKPg',
    uri: 'youtube:track:jBmhsV9NKPg',
  },
];

function main() {
  for (let item of corpus) {
    for (let key of ['url']) {
      let parsed = FreyrCore.parseURI(item[key]);
      if (parsed) {
        console.log(`⏩┬[ \x1b[36m${item[key]}\x1b[39m ]`);
        if (parsed.uri === item.uri) {
          console.log(`  ├ ✅ asURI -> \x1b[36m${parsed.uri}\x1b[39m`);
        } else {
          console.log(`  ├ ❌ asURI -> \x1b[36m${parsed.uri}\x1b[39m (expected \x1b[33m${item.uri}\x1b[39m)`);
        }
        if (parsed.url === item.url) {
          console.log(`  └ ✅ asURL -> \x1b[36m${parsed.url}\x1b[39m`);
        } else {
          console.log(`  └ ❌ asURL -> \x1b[36m${parsed.url}\x1b[39m (expected \x1b[33m${item.url}\x1b[39m)`);
        }
      } else {
        console.log(`❌─[ \x1b[36m${item[key]}\x1b[39m ]`);
      }
    }

    console.log();
  }
}

main();
