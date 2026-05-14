'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

const UserSchema = new Schema({
  name:     { type: String, required: true, trim: true },
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  phone:    { type: String, required: true },
  whatsappVerified:    { type: Boolean, default: false },
  whatsappOtp:         String,
  whatsappOtpExpiry:   Date,
  whatsappConnectedAt: Date,
  role: { type: String, enum: ['user', 'admin', 'superadmin'], default: 'user' },
  company: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
  preferences: {
    language:          { type: String, default: 'en' },
    currency:          { type: String, default: 'USD' },
    timezone:          { type: String, default: 'Africa/Nairobi' },
    alertFrequency:    { type: String, enum: ['instant','daily','weekly'], default: 'instant' },
    notifyViaWhatsApp: { type: Boolean, default: false },
    notifyViaEmail:    { type: Boolean, default: false }
  },
  subscription: {
    plan:    { type: String, enum: ['trial','free','starter','professional','enterprise'], default: 'trial' },
    status:  { type: String, enum: ['active','cancelled','expired','trial'], default: 'trial' },
    trialEndsAt:          Date,
    trialSearchesUsed:    { type: Number, default: 0 },
    expiresAt:            Date,
    stripeCustomerId:     String,
    stripeSubscriptionId: String,
    mpesaCustomerId:      String
  },
  quota: {
    searchesToday:   { type: Number, default: 0 },
    searchDate:      String,
    alertsThisMonth: { type: Number, default: 0 },
    alertMonth:      String
  },
  googleTokens:    { accessToken: String, refreshToken: String, expiresAt: Date },
  microsoftTokens: { accessToken: String, refreshToken: String, expiresAt: Date },
  lastActive: Date,
  createdAt:  { type: Date, default: Date.now }
});
UserSchema.index({ company: 1 });
UserSchema.index({ 'subscription.plan': 1 });
UserSchema.index({ 'subscription.trialEndsAt': 1 });

const CompanySchema = new Schema({
  name:               { type: String, required: true },
  registrationNumber: String,
  website:            String,
  logo:               String,
  description:        String,
  industry:           [String],
  services:           [String],
  yearsFounded:       Number,
  certifications: [{ name: String, issuedBy: String, validUntil: Date, documentUrl: String }],
  locations: [{ country: String, countryCode: String, region: String, city: String, isPrimary: Boolean }],
  targetLocations: [{ country: String, countryCode: String, region: String, city: String, radius: Number }],
  tenderPreferences: {
    minBudget: Number, maxBudget: Number,
    currency: { type: String, default: 'USD' },
    sectors: [String], excludeSectors: [String],
    tenderTypes: [String], preferredLanguages: [String]
  },
  knowledgeBase: {
    vectorNamespace: String, lastIndexed: Date,
    documentCount: { type: Number, default: 0 },
    documents: [{
      name: String,
      type: { type: String, enum: ['capability_statement','past_performance','certification','resume','proposal','other'] },
      url: String, uploadedAt: Date, indexed: { type: Boolean, default: false }
    }]
  },
  pastBids: [{
    tenderTitle: String, client: String, value: Number, currency: String,
    won: Boolean, year: Number, sector: String, country: String, proposalUrl: String
  }],
  competitorIntelligence: [{
    competitorName: String, country: String, sector: String,
    avgWinAmount: Number, currency: String, tendersWon: Number, lastUpdated: Date
  }],
  feedback: [{
    tenderId:  { type: Schema.Types.ObjectId, ref: 'Tender' },
    action:    { type: String, enum: ['interested','not_relevant','applied','won','lost'] },
    reason: String, timestamp: { type: Date, default: Date.now }
  }],
  plan:      { type: String, enum: ['trial','free','starter','professional','enterprise'], default: 'trial' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const TenderSchema = new Schema({
  title:           { type: String, required: true },
  description:     String,
  fullDescription: String,
  reference:       String,
  source: {
    name: String,
    url:  { type: String, required: true, unique: true },
    domain: String, country: String,
    type: { type: String, enum: ['government','parastatal','ngo','international','private','un','multilateral'] }
  },
  status:     { type: String, enum: ['active','closed','awarded','cancelled'], default: 'active' },
  category: String, sector: String,
  tenderType: { type: String, enum: ['goods','services','works','consulting','mixed'] },
  location: { country: String, countryCode: String, region: String, city: String, coordinates: { lat: Number, lng: Number } },
  financials: { estimatedValue: Number, currency: String, usdEquivalent: Number, budgetRange: { min: Number, max: Number } },
  dates: { published: Date, openingDate: Date, closingDate: Date, preBidMeeting: Date, awardDate: Date },
  requirements: { eligibility: [String], certifications: [String], experience: String, localContentRequirement: String, esgRequirements: String, technicalSpecs: [String] },
  documents: [{ name: String, url: String, type: String, language: String, extractedText: String }],
  language: { type: String, default: 'en' },
  translations: [{ language: String, title: String, description: String }],
  complianceFlags: [{ type: String, description: String, severity: { type: String, enum: ['blocker','warning','info'] } }],
  confidenceScore: Number, agentDiscovered: { type: Boolean, default: true },
  requiresHumanReview: { type: Boolean, default: false },
  shadowConflicts: [{ field: String, primaryValue: Schema.Types.Mixed, shadowValue: Schema.Types.Mixed }],
  scrapedAt: { type: Date, default: Date.now }, lastVerified: Date, expiresAt: Date
});
TenderSchema.index({ 'location.countryCode': 1 });
TenderSchema.index({ 'dates.closingDate': 1 });
TenderSchema.index({ sector: 1 });
TenderSchema.index({ status: 1, scrapedAt: -1 });
TenderSchema.index({ title: 'text', description: 'text' });

const TenderMatchSchema = new Schema({
  tender:  { type: Schema.Types.ObjectId, ref: 'Tender',  required: true },
  company: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
  matchScore: { type: Number, min: 0, max: 100 },
  confidenceScore: { type: Number, min: 0, max: 100 },
  reasoning: String,
  analysis: {
    strengths: [String], risks: [String], dealBreakers: [String], recommendations: [String],
    goNoGo: { type: String, enum: ['go','no_go','review'] },
    pastSimilarBid: { title: String, won: Boolean, year: Number, value: Number },
    timelineRisk: String, budgetAlignment: String
  },
  winProbability: {
    probability: Number, pricingInsight: String,
    gapAnalysis: [{ gap: String, severity: String, remedy: String }],
    historicalContext: String, recommendation: String
  },
  competitorInsight: {
    usualWinners: [{ name: String, avgBid: Number, currency: String, wins: Number }],
    pricePoint: { avg: Number, currency: String }
  },
  normalizedFinancials: Schema.Types.Mixed,
  shadowConflicts: [{ field: String, primaryValue: Schema.Types.Mixed, shadowValue: Schema.Types.Mixed }],
  requiresReview: { type: Boolean, default: false },
  alertSent: { type: Boolean, default: false }, alertSentAt: Date,
  userActions: [{
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, enum: ['viewed','interested','not_relevant','applied','drafted','won','lost'] },
    reason: String, timestamp: { type: Date, default: Date.now }
  }],
  proposal: { type: Schema.Types.ObjectId, ref: 'Proposal' },
  calendarEventIds: [String],
  isLocked: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
TenderMatchSchema.index({ tender: 1, company: 1 }, { unique: true });
TenderMatchSchema.index({ company: 1, matchScore: -1 });
TenderMatchSchema.index({ company: 1, createdAt: -1 });

const ProposalSchema = new Schema({
  tender:    { type: Schema.Types.ObjectId, ref: 'Tender',  required: true },
  company:   { type: Schema.Types.ObjectId, ref: 'Company', required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  title: String,
  status: { type: String, enum: ['draft','review','submitted','won','lost'], default: 'draft' },
  sections: { executiveSummary: String, technicalApproach: String, methodology: String, teamComposition: String, pastPerformance: String, financialProposal: String, compliance: String },
  completionPercentage: { type: Number, default: 0 },
  aiGenerated: { type: Boolean, default: false },
  emailedTo: [String], fileUrl: String, version: { type: Number, default: 1 },
  createdAt: { type: Date, default: Date.now }, updatedAt: { type: Date, default: Date.now }
});
ProposalSchema.index({ company: 1, createdAt: -1 });

const WhatsAppSessionSchema = new Schema({
  phone: { type: String, required: true, unique: true },
  user:    { type: Schema.Types.ObjectId, ref: 'User' },
  company: { type: Schema.Types.ObjectId, ref: 'Company' },
  state: { type: String, default: 'new' },
  context: { type: Schema.Types.Mixed, default: {} },
  lastMessage: String, lastActivity: { type: Date, default: Date.now },
  isGroupChat: { type: Boolean, default: false }, groupMembers: [String]
});

const PaymentSchema = new Schema({
  company:  { type: Schema.Types.ObjectId, ref: 'Company', required: true },
  user:     { type: Schema.Types.ObjectId, ref: 'User' },
  amount:   { type: Number, required: true },
  currency: { type: String, required: true },
  usdEquivalent: Number,
  method:   { type: String, enum: ['stripe','mpesa','paypal','bank_transfer'] },
  status:   { type: String, enum: ['pending','completed','failed','refunded'], default: 'pending' },
  plan: String, periodStart: Date, periodEnd: Date,
  stripePaymentIntentId: String, mpesaCheckoutRequestId: String, mpesaReceiptNumber: String,
  metadata: Schema.Types.Mixed, createdAt: { type: Date, default: Date.now }
});
PaymentSchema.index({ company: 1, createdAt: -1 });

module.exports = {
  User:            mongoose.model('User',            UserSchema),
  Company:         mongoose.model('Company',         CompanySchema),
  Tender:          mongoose.model('Tender',          TenderSchema),
  TenderMatch:     mongoose.model('TenderMatch',     TenderMatchSchema),
  Proposal:        mongoose.model('Proposal',        ProposalSchema),
  WhatsAppSession: mongoose.model('WhatsAppSession', WhatsAppSessionSchema),
  Payment:         mongoose.model('Payment',         PaymentSchema)
};
