import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

// Get the directory name for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from the root directory
dotenv.config({ path: path.join(__dirname, '../../.env') });

// Database configuration that supports both PostgreSQL and SQLite
const getDatabaseConfig = () => {
  console.log('🔍 DATABASE_URL:', process.env.DATABASE_URL);
  console.log('🔍 NODE_ENV:', process.env.NODE_ENV);
  // Check for PostgreSQL connection string (production)
  if (process.env.DATABASE_URL) {
    console.log('🐘 Using PostgreSQL database');
    return new Sequelize(process.env.DATABASE_URL, {
      dialect: 'postgres',
      dialectModule: pg, // Explicitly provide the pg module
      dialectOptions: {
        ssl: process.env.NODE_ENV === 'production' ? {
          require: true,
          rejectUnauthorized: false
        } : false
      },
      logging: process.env.NODE_ENV === 'development' ? console.log : false,
      pool: {
        max: 5,
        min: 0,
        acquire: 30000,
        idle: 10000
      }
    });
  }

  // Check for Vercel Postgres
  if (process.env.POSTGRES_URL) {
    console.log('🐘 Using Vercel PostgreSQL database');
    return new Sequelize(process.env.POSTGRES_URL, {
      dialect: 'postgres',
      dialectModule: pg, // Explicitly provide the pg module
      dialectOptions: {
        ssl: {
          require: true,
          rejectUnauthorized: false
        }
      },
      logging: false,
      pool: {
        max: 5,
        min: 0,
        acquire: 30000,
        idle: 10000
      }
    });
  }

  // Fallback to SQLite for development
  console.log('🗃️  Using SQLite database (development)');
  return new Sequelize({
    dialect: 'sqlite',
    storage: process.env.NODE_ENV === 'production' ? ':memory:' : './database.sqlite',
    logging: process.env.NODE_ENV === 'development' ? console.log : false
  });
};

const sequelize = getDatabaseConfig();

export const initDatabase = async () => {
  try {
    await sequelize.authenticate();
    
    const dialect = sequelize.getDialect();
    console.log(`✅ Connected to ${dialect.toUpperCase()} database successfully`);
    
    // Sync database (create tables)
    await sequelize.sync({ 
      alter: process.env.NODE_ENV === 'development',
      force: false // Never force in production
    });
    
    console.log('📊 Database synchronized');
  } catch (error) {
    console.error('❌ Unable to connect to database:', error);
    if (process.env.NODE_ENV === 'production') {
      throw error; // Don't exit in serverless environment
    } else {
      process.exit(1);
    }
  }
};

export default sequelize; 