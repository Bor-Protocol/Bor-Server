import { DataTypes, Op } from 'sequelize';
import sequelize from '../src/config/database.js';

const User = sequelize.define('User', {
  id: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    validate: {
      isEmail: true
    }
  },
  password: {
    type: DataTypes.STRING,
    allowNull: true // null for OAuth users
  },
  google_id: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true
  },
  avatar: {
    type: DataTypes.STRING,
    allowNull: true
  },
  points: {
    type: DataTypes.INTEGER,
    defaultValue: 100,
    allowNull: false
  },
  user_type: {
    type: DataTypes.ENUM('user', 'creator', 'admin'),
    defaultValue: 'user',
    allowNull: false
  },
  subscription_tier: {
    type: DataTypes.ENUM('free', 'premium', 'enterprise'),
    defaultValue: 'free',
    allowNull: false
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false
  },
  email_verified: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false
  },
  auth_provider: {
    type: DataTypes.ENUM('local', 'google'),
    defaultValue: 'local',
    allowNull: false
  },
  total_sessions: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    allowNull: false
  },
  points_next_regen: {
    type: DataTypes.DATE,
    allowNull: true
  },
  last_login: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'users',
  timestamps: true, // This gives us createdAt and updatedAt
  indexes: [
    {
      unique: true,
      fields: ['email']
    },
    {
      unique: true,
      fields: ['google_id'],
      where: {
        google_id: {
          [Op.ne]: null
        }
      }
    }
  ]
});

export default User;