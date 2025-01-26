import { DataTypes } from 'sequelize';
import sequelize from '../src/config/database.js';

const AIResponse = sequelize.define('AIResponse', {
  id: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false
  },
  agentId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  text: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  thought: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  createdAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
});

export default AIResponse;