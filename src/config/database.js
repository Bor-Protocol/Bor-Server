import { Sequelize } from 'sequelize';

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: './database.sqlite',
  logging: false // Set to true for SQL query logging
});

export const initDatabase = async () => {
  try {
    await sequelize.authenticate();
    console.log('Connected to SQLite database successfully');
    await sequelize.sync({ alter: true });
    console.log('Database synchronized');
  } catch (error) {
    console.error('Unable to connect to database:', error);
    process.exit(1);
  }
};

export default sequelize; 