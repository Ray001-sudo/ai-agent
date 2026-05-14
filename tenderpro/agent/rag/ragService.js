const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI       = require('openai').default;
const pdf          = require('pdf-parse');
const fs           = require('fs').promises;
const path         = require('path');
const { logger }   = require('../agent/utils/logger');
const { Company }  = require('../backend/models');

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

class RAGService {
  constructor() { this.index = pinecone.Index(process.env.PINECONE_INDEX_NAME || 'tenderpro-vectors'); }

  async indexDocument(companyId, text, documentType) {
    const company   = await Company.findById(companyId);
    const namespace = company?.knowledgeBase?.vectorNamespace || `company-${companyId}`;
    if (!text || text.length < 50) return false;
    const chunks  = this._chunk(text, 1500);
    const vectors = [];
    for (let i = 0; i < chunks.length; i++) {
      const emb = await this._embed(chunks[i]);
      vectors.push({ id:`${companyId}-${documentType}-${Date.now()}-${i}`, values:emb, metadata:{ companyId:String(companyId), content:chunks[i].substring(0,1000), documentType, chunkIndex:i, indexedAt:new Date().toISOString() } });
    }
    for (let i = 0; i < vectors.length; i += 100) await this.index.namespace(namespace).upsert(vectors.slice(i,i+100));
    await Company.findByIdAndUpdate(companyId, { 'knowledgeBase.lastIndexed':new Date(), $inc:{'knowledgeBase.documentCount':1} });
    logger.info(`RAG: indexed ${chunks.length} chunks for company ${companyId}`);
    return true;
  }

  async indexCompanyProfile(companyId) {
    const c = await Company.findById(companyId);
    if (!c) return;
    const text = `COMPANY: ${c.name}\nSERVICES: ${(c.services||[]).join('\n')}\nINDUSTRY: ${(c.industry||[]).join('\n')}\nCERTIFICATIONS: ${(c.certifications||[]).map(x=>x.name).join('\n')}\nPAST BIDS:\n${(c.pastBids||[]).map(b=>`${b.tenderTitle} — ${b.won?'WON':'Lost'} — ${b.country} ${b.year}`).join('\n')}`;
    await this.indexDocument(companyId, text, 'company_profile');
  }

  async retrieveContext(companyId, query, topK = 5) {
    const company   = await Company.findById(companyId);
    const namespace = company?.knowledgeBase?.vectorNamespace || `company-${companyId}`;
    const emb       = await this._embed(query);
    const results   = await this.index.namespace(namespace).query({ vector:emb, topK, includeMetadata:true });
    return (results.matches||[]).filter(m=>m.score>0.5).map(m=>({ content:m.metadata?.content||'', documentType:m.metadata?.documentType, score:m.score }));
  }

  async processUploadedFile(companyId, filePath, documentType) {
    const ext = path.extname(filePath).toLowerCase();
    let text  = '';
    try {
      if (ext === '.pdf') { const buf = await fs.readFile(filePath); const d = await pdf(buf); text = d.text; }
      else if (['.txt','.md'].includes(ext)) { text = await fs.readFile(filePath,'utf-8'); }
      else if (ext === '.json') { text = JSON.stringify(JSON.parse(await fs.readFile(filePath,'utf-8')), null, 2); }
      if (text.length > 100) { await this.indexDocument(companyId, text, documentType); return { success:true, chunks:this._chunk(text,1500).length }; }
    } catch (e) { logger.error(`File processing failed: ${e.message}`); return { success:false, error:e.message }; }
  }

  async _embed(text) {
    const r = await openai.embeddings.create({ model:'text-embedding-3-large', input:text.substring(0,8000) });
    return r.data[0].embedding;
  }

  _chunk(text, size) {
    const words = text.split(/\s+/); const chunks = []; let cur = [], len = 0;
    for (const w of words) { cur.push(w); len += w.length+1; if (len >= size) { chunks.push(cur.join(' ')); cur=[]; len=0; } }
    if (cur.length) chunks.push(cur.join(' '));
    return chunks;
  }
}

module.exports = { RAGService };
