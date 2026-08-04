// Short lessons + comprehension checks for "Learn Everything About Markets &
// Trading" — deliberately simpler and more basic than the Advanced Trading
// Course, aimed at someone just starting out.
module.exports = [
  {
    title: 'What a market actually is',
    body: 'A market is just a place where buyers and sellers agree on a price. Every price you see on a chart is the last point where someone was willing to buy and someone else was willing to sell at the same number.',
    quiz: {
      q: 'A market price moves because...',
      options: ['A company official sets it each morning', 'Buyers and sellers agree on a new price', 'A computer randomly generates it'],
      correct: 1,
      explain: 'Price is simply where the most recent trade happened — it moves as buyers and sellers agree on new levels.',
    },
  },
  {
    title: 'Long vs. short',
    body: "Going 'long' means buying first, hoping to sell later at a higher price. Going 'short' means selling first (borrowing the asset), hoping to buy it back later at a lower price. Both are just betting on direction — up or down.",
    quiz: {
      q: 'If you think a price will fall, you would typically...',
      options: ['Go long', 'Go short', 'Do nothing, you can only profit from rises'],
      correct: 1,
      explain: 'Shorting lets you profit from a price falling, by selling first and buying back lower.',
    },
  },
  {
    title: 'Why risk comes before reward',
    body: "Before asking 'how much can I make,' professional traders ask 'how much can I lose, and can I survive that.' A single oversized loss can undo dozens of small wins.",
    quiz: {
      q: "The first question before entering any trade should be:",
      options: ['How much could I make?', 'How much am I risking if I\'m wrong?', 'What are other traders doing?'],
      correct: 1,
      explain: "Defining your risk first is what keeps one bad trade from being a account-ending trade.",
    },
  },
  {
    title: 'Volatility isn\'t the same as risk',
    body: "A volatile asset moves a lot, but that alone isn't 'risky' if your position size accounts for it. Real risk is the size of the loss relative to your account, not how much a price wiggles.",
    quiz: {
      q: 'A highly volatile asset is automatically high-risk to trade.',
      options: ['True — volatility and risk are the same thing', 'False — risk depends on position size relative to your account, not volatility alone'],
      correct: 1,
      explain: 'You can trade a volatile asset safely with a small enough position; the danger is sizing that ignores volatility.',
    },
  },
  {
    title: 'Why a trading plan beats a hunch',
    body: 'A plan written down before you trade — entry, stop, target — removes the moment-to-moment emotional decision-making that causes most costly mistakes. A hunch has no rule to check yourself against.',
    quiz: {
      q: 'The main benefit of writing a trading plan before entering is:',
      options: ['It guarantees the trade will win', 'It gives you a fixed rule to follow instead of deciding emotionally mid-trade', 'It is required by law'],
      correct: 1,
      explain: 'A plan is a pre-commitment device — it removes decisions from the moment you\'re most likely to make a bad one.',
    },
  },
];
