import { DataTypes } from 'sequelize';
import sequelize from '../src/config/database.js';

const ModelConfig = sequelize.define('ModelConfig', {
  id: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false
  },
  agentId: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  modelName: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true // 'trump', 'borp', 'alpha'
  },
  displayName: {
    type: DataTypes.STRING,
    allowNull: false
  },
  accessType: {
    type: DataTypes.ENUM('free', 'premium'),
    allowNull: false,
    defaultValue: 'premium'
  },
  pointsCost: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  maxConcurrentSessions: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  },
  sessionDurationMinutes: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 5
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  avatar: {
    type: DataTypes.STRING,
    allowNull: true
  },
  background: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'model_configurations',
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['modelName']
    },
    {
      unique: true,
      fields: ['agentId']
    },
    {
      fields: ['accessType', 'isActive']
    }
  ]
});

export default ModelConfig;