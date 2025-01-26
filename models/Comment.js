import { DataTypes } from 'sequelize';
import sequelize from '../src/config/database.js';

const Comment = sequelize.define('Comment', {
  id: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false
  },
  agentId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  user: {
    type: DataTypes.STRING,
    allowNull: false
  },
  message: {
    type: DataTypes.STRING,
    allowNull: false
  },
  avatar: {
    type: DataTypes.STRING,
    allowNull: false
  },
  handle: {
    type: DataTypes.STRING,
    allowNull: true
  },
  readByAgent: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  createdAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
});

export default Comment;
