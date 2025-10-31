import mongoose from 'mongoose';

const LinkCodeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    code: { type: String, unique: true, index: true },
    usedAt: { type: Date },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

export default mongoose.model('LinkCode', LinkCodeSchema);


