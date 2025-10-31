import mongoose from 'mongoose';

const MediatorAuditSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    action: { type: String },
    tokenId: { type: String },
    ip: { type: String },
    success: { type: Boolean },
    status: { type: Number },
    meta: { type: Object },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

export default mongoose.model('MediatorAudit', MediatorAuditSchema);


