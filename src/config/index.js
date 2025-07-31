// Unified database configuration
const dbConfig = process.env.NODE_ENV === 'production' 
  ? require('./database.production.js')
  : require('./database.js');

export default dbConfig;