import { DataTypes } from 'sequelize';
import sequelize from '../src/config/database.js';

const Session = sequelize.define('Session', {
  id: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false
  },
  userId: {
    type: DataTypes.STRING,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  agentId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  type: {
    type: DataTypes.ENUM('private', 'public'),
    allowNull: false,
    defaultValue: 'private'
  },
  status: {
    type: DataTypes.ENUM('active', 'completed', 'cancelled', 'queued'),
    allowNull: false,
    defaultValue: 'queued'
  },
  duration: {
    type: DataTypes.INTEGER, // Duration in minutes
    allowNull: false,
    defaultValue: 5
  },
  pointsCost: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 10
  },
  startTime: {
    type: DataTypes.DATE,
    allowNull: true
  },
  endTime: {
    type: DataTypes.DATE,
    allowNull: true
  },
  queuePosition: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  estimatedWaitTime: {
    type: DataTypes.INTEGER, // Wait time in minutes
    allowNull: true
  }
}, {
  tableName: 'sessions',
  timestamps: true,
  indexes: [
    {
      fields: ['userId']
    },
    {
      fields: ['agentId', 'status']
    },
    {
      fields: ['status', 'createdAt']
    }
  ]
});

export default Session;