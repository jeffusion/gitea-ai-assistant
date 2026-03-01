const a = require('./dist/review/engine');
const b = require('@/review/engine');
console.log('same?', a.reviewEngine === b.reviewEngine);
console.log('a file', require.resolve('./dist/review/engine'));
console.log('b file', require.resolve('@/review/engine'));
