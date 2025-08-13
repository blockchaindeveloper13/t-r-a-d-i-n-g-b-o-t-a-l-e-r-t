const Parser = require('rss-parser');
const parser = new Parser();

const RSS_LINKS = [
  'https://cointelegraph.com/rss',
  'https://www.coindesk.com/arc/outboundfeeds/rss',
  'https://www.newsbtc.com/feed/',
  'https://rss.app/feeds/v1.1/afLheyG37mUeVDxY.json'
];

async function fetchNews() {
  let news = [];
  for (const url of RSS_LINKS) {
    try {
      const feed = await parser.parseURL(url);
      news.push(...feed.items.slice(0, 5).map(item => item.title + ': ' + (item.contentSnippet || '')));
    } catch (e) {
      news.push(`${url} veri çekilemedi!`);
    }
  }
  return news;
}

module.exports = { fetchNews };
