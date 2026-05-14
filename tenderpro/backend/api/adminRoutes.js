'use strict';
const express  = require('express');
const router   = express.Router();
const { adminOnly } = require('../middleware/auth');
const { User, Company, Tender, TenderMatch, Proposal, Payment } = require('../models');
const { logger } = require('../utils/logger');

router.use(adminOnly);

router.get('/stats', async (req, res) => {
  const [totalUsers, trialUsers, paidUsers, newToday, newWeek, newMonth, totalCompanies, totalTenders, activeTenders, totalMatches, revenueAgg, revenueMonth] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ 'subscription.plan': 'trial' }),
    User.countDocuments({ 'subscription.plan': { $in: ['starter','professional','enterprise'] } }),
    User.countDocuments({ createdAt: { $gte: new Date(Date.now()-86400000) } }),
    User.countDocuments({ createdAt: { $gte: new Date(Date.now()-7*86400000) } }),
    User.countDocuments({ createdAt: { $gte: new Date(Date.now()-30*86400000) } }),
    Company.countDocuments(),
    Tender.countDocuments(),
    Tender.countDocuments({ status:'active' }),
    TenderMatch.countDocuments(),
    Payment.aggregate([{$match:{status:'completed'}},{$group:{_id:null,total:{$sum:'$usdEquivalent'}}}]),
    Payment.aggregate([{$match:{status:'completed',createdAt:{$gte:new Date(Date.now()-30*86400000)}}},{$group:{_id:null,total:{$sum:'$usdEquivalent'}}}])
  ]);
  res.json({ users:{ total:totalUsers, trial:trialUsers, paid:paidUsers, free:totalUsers-trialUsers-paidUsers, newToday, newWeek, newMonth }, companies:totalCompanies, tenders:{total:totalTenders,active:activeTenders}, matches:totalMatches, revenue:{ allTime:Math.round(revenueAgg[0]?.total||0), thisMonth:Math.round(revenueMonth[0]?.total||0) } });
});

router.get('/analytics/signups', async (req, res) => {
  const days=parseInt(req.query.days)||30;
  const data=await User.aggregate([{$match:{createdAt:{$gte:new Date(Date.now()-days*86400000)}}},{$group:{_id:{$dateToString:{format:'%Y-%m-%d',date:'$createdAt'}},count:{$sum:1}}},{$sort:{_id:1}}]);
  res.json(data);
});

router.get('/analytics/plans', async (req, res) => {
  const data=await User.aggregate([{$group:{_id:'$subscription.plan',count:{$sum:1}}},{$sort:{count:-1}}]);
  res.json(data);
});

router.get('/analytics/conversion', async (req, res) => {
  const [totalTrials,converted,expired]=await Promise.all([
    User.countDocuments({'subscription.trialEndsAt':{$exists:true}}),
    User.countDocuments({'subscription.plan':{$in:['starter','professional','enterprise']}}),
    User.countDocuments({'subscription.plan':'trial','subscription.trialEndsAt':{$lt:new Date()}})
  ]);
  res.json({totalTrials,converted,expired,conversionRate:totalTrials?Math.round(converted/totalTrials*100):0});
});

router.get('/analytics/revenue', async (req, res) => {
  const data=await Payment.aggregate([{$match:{status:'completed'}},{$group:{_id:'$method',total:{$sum:'$usdEquivalent'},count:{$sum:1}}}]);
  res.json(data);
});

router.get('/users', async (req, res) => {
  const {page=1,limit=50,plan,search,sort='-createdAt'}=req.query;
  const q={};
  if(plan) q['subscription.plan']=plan;
  if(search){const re=new RegExp(search,'i');q.$or=[{name:re},{email:re},{phone:re}];}
  const [users,total]=await Promise.all([User.find(q).select('-password -whatsappOtp -googleTokens').populate('company','name plan').sort(sort).skip((page-1)*limit).limit(parseInt(limit)),User.countDocuments(q)]);
  res.json({users,total,page:parseInt(page),pages:Math.ceil(total/limit)});
});

router.get('/users/:id', async (req, res) => {
  const user=await User.findById(req.params.id).select('-password -whatsappOtp').populate('company');
  if(!user) return res.status(404).json({error:'Not found'});
  const [matchCount,proposalCount,payments]=await Promise.all([TenderMatch.countDocuments({company:user.company?._id}),Proposal.countDocuments({company:user.company?._id}),Payment.find({company:user.company?._id}).sort({createdAt:-1}).limit(10)]);
  res.json({user,stats:{matches:matchCount,proposals:proposalCount},payments});
});

router.patch('/users/:id/plan', async (req, res) => {
  const {plan,daysFromNow}=req.body;
  if(!['trial','free','starter','professional','enterprise'].includes(plan)) return res.status(400).json({error:'Invalid plan'});
  const expiresAt=daysFromNow?new Date(Date.now()+daysFromNow*86400000):undefined;
  const update={'subscription.plan':plan,'subscription.status':plan==='trial'?'trial':'active',...(expiresAt&&{'subscription.expiresAt':expiresAt}),...(plan==='trial'&&{'subscription.trialEndsAt':expiresAt||new Date(Date.now()+3*86400000)})};
  const user=await User.findByIdAndUpdate(req.params.id,update,{new:true}).select('-password');
  if(!user) return res.status(404).json({error:'Not found'});
  await Company.findByIdAndUpdate(user.company,{plan});
  logger.info(`Admin ${req.admin.email} → ${user.email} plan: ${plan}`);
  res.json({success:true,user});
});

router.patch('/users/:id/extend-trial', async (req, res) => {
  const {days=3}=req.body;
  const newEnd=new Date(Date.now()+days*86400000);
  const user=await User.findByIdAndUpdate(req.params.id,{'subscription.plan':'trial','subscription.status':'trial','subscription.trialEndsAt':newEnd},{new:true}).select('-password');
  if(!user) return res.status(404).json({error:'Not found'});
  res.json({success:true,trialEndsAt:newEnd});
});

router.patch('/users/:id/suspend', async (req, res) => {
  const user=await User.findByIdAndUpdate(req.params.id,{'subscription.status':'cancelled','subscription.plan':'free'},{new:true}).select('-password');
  if(!user) return res.status(404).json({error:'Not found'});
  logger.warn(`Admin ${req.admin.email} suspended ${user.email}`);
  res.json({success:true});
});

router.delete('/users/:id', async (req, res) => {
  const user=await User.findById(req.params.id);
  if(!user) return res.status(404).json({error:'Not found'});
  await Promise.all([User.deleteOne({_id:req.params.id}),TenderMatch.deleteMany({company:user.company}),Proposal.deleteMany({company:user.company}),Payment.deleteMany({company:user.company}),Company.deleteOne({_id:user.company})]);
  logger.warn(`Admin ${req.admin.email} DELETED ${user.email}`);
  res.json({success:true,deleted:user.email});
});

router.get('/companies', async (req, res) => {
  const {page=1,limit=50,search}=req.query;
  const q=search?{name:new RegExp(search,'i')}:{};
  const [companies,total]=await Promise.all([Company.find(q).sort({createdAt:-1}).skip((page-1)*limit).limit(parseInt(limit)),Company.countDocuments(q)]);
  res.json({companies,total});
});

router.get('/payments', async (req, res) => {
  const {page=1,limit=50,status}=req.query;
  const q=status?{status}:{};
  const [payments,total]=await Promise.all([Payment.find(q).populate('user','name email').populate('company','name').sort({createdAt:-1}).skip((page-1)*limit).limit(parseInt(limit)),Payment.countDocuments(q)]);
  res.json({payments,total});
});

router.get('/tenders', async (req, res) => {
  const {page=1,limit=50,status,country}=req.query;
  const q={};
  if(status) q.status=status;
  if(country) q['location.country']=new RegExp(country,'i');
  const [tenders,total]=await Promise.all([Tender.find(q).sort({scrapedAt:-1}).skip((page-1)*limit).limit(parseInt(limit)),Tender.countDocuments(q)]);
  res.json({tenders,total});
});

router.get('/health', async (req, res) => {
  const {getRedisClient}=require('../utils/redis');
  let redisOk=false;
  try{await getRedisClient().ping();redisOk=true;}catch{}
  res.json({mongodb:'connected',redis:redisOk?'connected':'disconnected',providers:{anthropic:!!process.env.ANTHROPIC_API_KEY,openai:!!process.env.OPENAI_API_KEY,nvidia:!!process.env.NVIDIA_API_KEY},uptime:Math.round(process.uptime()),memory:process.memoryUsage(),env:process.env.NODE_ENV,version:'1.0.0'});
});

router.post('/message/:userId', async (req, res) => {
  const {message}=req.body;
  if(!message) return res.status(400).json({error:'message required'});
  const user=await User.findById(req.params.userId);
  if(!user) return res.status(404).json({error:'Not found'});
  try{const {sendWhatsAppMessage}=require('../whatsapp/whatsAppClient');await sendWhatsAppMessage(user.phone,`📢 *TenderPro Admin:*\n\n${message}`);res.json({success:true});}
  catch(e){res.status(500).json({error:e.message});}
});

router.post('/login', async (req, res) => {
  const {email,password}=req.body;
  const bcrypt=require('bcryptjs');
  const jwt=require('jsonwebtoken');
  const user=await User.findOne({email,role:'superadmin'}).select('+password');
  if(!user||!await bcrypt.compare(password,user.password)) return res.status(404).json({error:'Not found'});
  const token=jwt.sign({id:user._id},process.env.JWT_SECRET,{expiresIn:'12h'});
  res.cookie('tp_admin_token',token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',maxAge:12*3600000});
  res.json({token,name:user.name,email:user.email});
});

module.exports = router;
