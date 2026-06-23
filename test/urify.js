import FreyrCore from '../src/freyr.js';

let corpus = [
  {
    url: 'https://www.deezer.com/en/track/642674232',
    uri: 'deezer:track:642674232',
  },
  {
    url: 'https://www.deezer.com/en/album/99687992',
    uri: 'deezer:album:99687992',
  },
  {
    url: 'https://www.deezer.com/en/artist/5340439',
    uri: 'deezer:artist:5340439',
  },
  {
    url: 'https://www.deezer.com/en/playlist/1963962142',
    uri: 'deezer:playlist:1963962142',
  },
];

function main() {
  for (let item of corpus) {
    for (let key in item) {
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
