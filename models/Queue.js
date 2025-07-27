import { DataTypes } from 'sequelize';
import sequelize from '../src/config/database.js';

const Queue = sequelize.define('Queue', {
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
  position: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('waiting', 'called', 'expired', 'completed'),
    allowNull: false,
    defaultValue: 'waiting'
  },
  estimatedWaitTime: {
    type: DataTypes.INTEGER, // Wait time in minutes
    allowNull: true
  },
  notified: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'queue',
  timestamps: true,
  indexes: [
    {
      fields: ['agentId', 'status', 'position']
    },
    {
      fields: ['userId', 'status']
    },
    {
      fields: ['status', 'createdAt']
    }
  ]
});

export default Queue;