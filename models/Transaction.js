import { DataTypes } from 'sequelize';
import sequelize from '../src/config/database.js';

const Transaction = sequelize.define('Transaction', {
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
  type: {
    type: DataTypes.ENUM('spend', 'earn', 'regenerate', 'bonus'),
    allowNull: false
  },
  amount: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  description: {
    type: DataTypes.STRING,
    allowNull: false
  },
  relatedId: {
    type: DataTypes.STRING,
    allowNull: true // For session IDs, bonus IDs, etc.
  },
  balanceBefore: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  balanceAfter: {
    type: DataTypes.INTEGER,
    allowNull: false
  }
}, {
  tableName: 'transactions',
  timestamps: true,
  indexes: [
    {
      fields: ['userId', 'createdAt']
    },
    {
      fields: ['type']
    }
  ]
});

export default Transaction;