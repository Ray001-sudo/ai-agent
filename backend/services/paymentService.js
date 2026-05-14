const axios  = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Payment, User, Company } = require('../models');
const { logger } = require('../utils/logger');

async function getMpesaToken() {
  const base  = process.env.MPESA_ENVIRONMENT === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  const creds = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const r = await axios.get(`${base}/oauth/v1/generate?grant_type=client_credentials`, { headers:{ Authorization:`Basic ${creds}` } });
  return r.data.access_token;
}

async function initiateMpesaPayment(phoneNumber, amount, description) {
  const token = await getMpesaToken();
  const ts    = new Date().toISOString().replace(/[-T:.Z]/g,'').slice(0,14);
  const sc    = process.env.MPESA_SHORTCODE;
  const pw    = Buffer.from(`${sc}${process.env.MPESA_PASSKEY}${ts}`).toString('base64');
  let phone   = phoneNumber.replace(/[^0-9]/g,'');
  if (phone.startsWith('0')) phone = '254'+phone.slice(1);
  if (!phone.startsWith('254')) phone = '254'+phone;
  const base  = process.env.MPESA_ENVIRONMENT === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  const r = await axios.post(`${base}/mpesa/stkpush/v1/processrequest`, { BusinessShortCode:sc, Password:pw, Timestamp:ts, TransactionType:'CustomerPayBillOnline', Amount:Math.round(amount), PartyA:phone, PartyB:sc, PhoneNumber:phone, CallBackURL:process.env.MPESA_CALLBACK_URL, AccountReference:'TenderPro', TransactionDesc:description }, { headers:{ Authorization:`Bearer ${token}` } });
  logger.info(`M-Pesa STK pushed: ${r.data.CheckoutRequestID}`);
  return r.data;
}

async function handleMpesaCallback(data) {
  const { Body:{ stkCallback } } = data;
  if (stkCallback.ResultCode !== 0) { await Payment.findOneAndUpdate({ mpesaCheckoutRequestId:stkCallback.CheckoutRequestID }, { status:'failed' }); return; }
  const meta = {}; (stkCallback.CallbackMetadata?.Item||[]).forEach(i => { meta[i.Name]=i.Value; });
  const p = await Payment.findOneAndUpdate({ mpesaCheckoutRequestId:stkCallback.CheckoutRequestID }, { status:'completed', mpesaReceiptNumber:meta.MpesaReceiptNumber, metadata:meta }, { new:true });
  if (p) await activateSubscription(p.company, p.plan, p.periodEnd);
}

async function initiateStripePayment(userId, planName) {
  const plans = { starter:{amount:999}, professional:{amount:4999}, enterprise:{amount:19999} };
  const plan  = plans[planName]; if (!plan) throw new Error(`Invalid plan: ${planName}`);
  const user  = await User.findById(userId);
  let cid     = user.subscription?.stripeCustomerId;
  if (!cid) { const c = await stripe.customers.create({ email:user.email, name:user.name }); cid = c.id; await User.findByIdAndUpdate(userId, { 'subscription.stripeCustomerId':cid }); }
  const intent = await stripe.paymentIntents.create({ amount:plan.amount, currency:'usd', customer:cid, metadata:{ planName, userId:userId.toString(), companyId:user.company.toString() } });
  return { clientSecret:intent.client_secret, paymentIntentId:intent.id };
}

async function handleStripeWebhook(event) {
  if (event.type === 'payment_intent.succeeded') {
    const { planName, companyId } = event.data.object.metadata;
    await activateSubscription(companyId, planName);
  }
}

async function activateSubscription(companyId, planName, expiresAt) {
  const limits = { starter:20, professional:100, enterprise:-1 };
  const expiry = expiresAt || new Date(Date.now() + 30*24*3600000);
  await Company.findByIdAndUpdate(companyId, { plan:planName });
  const users = await User.find({ company:companyId });
  for (const u of users) {
    await User.findByIdAndUpdate(u._id, { 'subscription.plan':planName, 'subscription.status':'active', 'subscription.expiresAt':expiry, 'subscription.alertLimitPerMonth':limits[planName]||-1 });
  }
  logger.info(`Subscription activated: ${planName} for company ${companyId}`);
}

module.exports = { initiateMpesaPayment, handleMpesaCallback, initiateStripePayment, handleStripeWebhook, activateSubscription };
