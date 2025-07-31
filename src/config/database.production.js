import { Sequelize } from 'sequelize';

// Production database configuration
const getDatabaseConfig = () => {
  // For Vercel Postgres
  if (process.env.POSTGRES_URL) {
    return new Sequelize(process.env.POSTGRES_URL, {
      dialect: 'postgres',
      dialectOptions: {
        ssl: {
          require: true,
          rejectUnauthorized: false
        }
      },
      logging: false
    });
  }
  
  // For external PostgreSQL (Supabase, Neon, etc.)
  if (process.env.DATABASE_URL) {
    return new Sequelize(process.env.DATABASE_URL, {
      dialect: 'postgres',
      dialectOptions: {
        ssl: {
          require: true,
          rejectUnauthorized: false
        }
      },
      logging: false
    });
  }
  
  // Fallback to SQLite for development
  console.warn('No production database configured, falling back to SQLite');
  return new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:', // Use in-memory for serverless
    logging: false
  });
};

const sequelize = getDatabaseConfig();

export const initDatabase = async () => {
  try {
    await sequelize.authenticate();
    console.log('Connected to database successfully');
    await sequelize.sync({ alter: true });
    console.log('Database synchronized');
  } catch (error) {
    console.error('Unable to connect to database:', error);
    throw error; // Don't exit in serverless environment
  }
};

export default sequelize;