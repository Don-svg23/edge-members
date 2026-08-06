// Maps Shopify product handles to what the member's dashboard unlocks.
// "real: true" means actual content/software exists; "real: false" shows
// a coming-soon state even if purchased, since the underlying thing
// hasn't been built (or honestly can't be built the way it's marketed).
module.exports = [
  {
    handle: 'asset-pack-89298370562-example-product-1',
    name: 'Advanced Trading Course',
    kind: 'course',
    real: true,
    price: '1495 kr',
  },
  {
    handle: 'asset-pack-89298370562-example-product-3',
    name: 'Private Trading Community',
    kind: 'discord',
    real: true,
    price: '675 kr',
    discordUrl: 'https://discord.gg/54rM9G5F4K',
  },
  {
    handle: 'asset-pack-89298370562-example-product-2',
    name: 'AI Trading Mentor',
    kind: 'mentor',
    real: true,
    price: '895 kr',
    mentorUrl: process.env.MENTOR_URL || 'http://localhost:4100',
  },
  {
    handle: 'learn-everything-about-markets-and-trading',
    name: 'Learn Everything About Markets & Trading',
    kind: 'lessons',
    real: true,
    price: '499 kr',
  },
  {
    handle: 'trading-journal-template-excel',
    name: 'Trading Journal Template (Excel)',
    kind: 'file',
    real: true,
    price: '299 kr',
    file: 'trading-journal-template.xlsx',
  },
  {
    handle: 'position-size-amp-risk-calculator-excel',
    name: 'Position Size & Risk Calculator (Excel)',
    kind: 'file',
    real: true,
    price: '199 kr',
    file: 'position-size-risk-calculator.xlsx',
  },
  {
    handle: 'signal-engine',
    name: 'Setup Checklist',
    kind: 'checklist',
    real: true,
    price: '245 kr/mo',
  },
  {
    handle: 'risk-console',
    name: 'Risk Console',
    kind: 'calculator',
    real: true,
    price: '935 kr/mo',
  },
  {
    handle: 'the-ledger',
    name: 'The Ledger',
    kind: 'ledger',
    real: true,
    price: '515 kr/mo',
  },
  {
    handle: 'backtest-suite',
    name: 'Strategy Lab',
    kind: 'strategylab',
    real: true,
    price: '315 kr/mo',
  },
  {
    handle: 'the-desk-bundle',
    name: 'The Desk Bundle',
    kind: 'bundle',
    real: true,
    price: '1690 kr/mo',
  },
];
