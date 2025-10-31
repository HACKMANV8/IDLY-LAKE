import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema(
  {
    username: { type: String },
    githubId: { type: String, index: true, unique: true },
    encryptedGithubToken: { type: String },
    tokenMeta: {
      scopes: { type: [String], default: [] },
      obtainedAt: { type: Date },
    },
    telegramId: { type: String },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

export default mongoose.model('User', UserSchema);


