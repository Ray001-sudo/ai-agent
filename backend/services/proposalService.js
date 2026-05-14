const { Proposal } = require('../models');
const { sendProposalDraft } = require('./allServices');
const { logger } = require('../utils/logger');

async function generateProposalAndEmail(tender, company, user, matchData) {
  const { AIMatchingEngine } = require('../agents/aiMatchingEngine');
  const engine = new AIMatchingEngine();
  const draft  = await engine.generateProposalDraft(tender, company, matchData);
  const proposal = await Proposal.create({ tender: tender._id, company: company._id, createdBy: user._id, title: `Draft: ${tender.title}`, sections: { executiveSummary: draft }, completionPercentage: 60, aiGenerated: true });
  await sendProposalDraft(user.email, tender.title, draft, proposal._id);
  logger.info(`Proposal emailed: ${proposal._id}`);
  return proposal;
}

module.exports = { generateProposalAndEmail };
