import TelegramBot from 'node-telegram-bot-api';
import bip39 from 'bip39';
import * as ed25519 from 'ed25519-hd-key';
import pkg from '@solana/web3.js';
const { Keypair, Connection, PublicKey, TOKEN_PROGRAM_ID } = pkg;
import bs58 from 'bs58';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const connection = new Connection('https://proud-aged-flower.solana-mainnet.quiknode.pro/6c4369466a2cfc21c12af4a500501aa9b0093340', {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000
});

// متغير لتتبع وضع البوت لكل مستخدم
const userModes = new Map();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function retryWithBackoff(fn, maxRetries = 5) {
  let retries = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (retries >= maxRetries || !error.message.includes('429')) {
        throw error;
      }
      const delay = Math.min(1000 * Math.pow(2, retries), 8000);
      await sleep(delay);
      retries++;
    }
  }
}

async function getTokenAccounts(address) {
  try {
    if (!address || typeof address !== 'string') {
      return [];
    }

    let pubKey;
    try {
      pubKey = new PublicKey(address);
    } catch (error) {
      console.error("Invalid address format:", address);
      return [];
    }

    const response = await retryWithBackoff(() => 
      connection.getParsedTokenAccountsByOwner(
        pubKey,
        { programId: TOKEN_PROGRAM_ID }
      )
    );
    return response?.value || [];
  } catch (error) {
    // تقليل عدد سجلات الأخطاء لتجنب إزعاج السجلات
    if (!error.message.includes('429')) {
      console.error("Error getting token accounts for address:", address, error.message);
    }
    return [];
  }
}

async function calculateBurnCost(addressStr) {
  try {
    if (!addressStr) {
      return {
        emptyTokens: 0,
        nfts: 0,
        totalBurnCost: "0.000000000"
      };
    }
    const tokens = await getTokenAccounts(addressStr);
    let tokenCount = 0;
    let nftCount = 0;

    for (const token of tokens) {
      const amount = token.account.data.parsed.info.tokenAmount.amount;
      const decimals = token.account.data.parsed.info.tokenAmount.decimals;

      if (amount === "0") {
        tokenCount++;
      } else if (decimals === 0 && amount === "1") {
        nftCount++;
      }
    }

    const burnCostPerAccount = 0.00203928;
    const totalBurnCost = (tokenCount + nftCount) * burnCostPerAccount;

    return {
      emptyTokens: tokenCount,
      nfts: nftCount,
      totalBurnCost: totalBurnCost.toFixed(9)
    };
  } catch (error) {
    console.error("Error calculating burn cost:", error);
    return {
      emptyTokens: 0,
      nfts: 0,
      totalBurnCost: "0.000000000"
    };
  }
}

function* generatePaths() {
  const specificPaths = [
    "m/44'/501'/10'/0'",
    "m/44'/501'/9'/0'",
    "m/44'/501'/8'/0'",
    "m/44'/501'/7'/0'",
    "m/44'/501'/6'/0'",
    "m/44'/501'/5'/0'",
    "m/44'/501'/4'/0'",
    "m/44'/501'/3'/0'",
    "m/44'/501'/2'/0'",
    "m/44'/501'/1'/0'",
    "m/44'/501'/0'",
    "m/44'/501'/0'/0'"
  ];

  for (const path of specificPaths) {
    yield path;
  }
}

async function scanDerivationPath(path, seed) {
  try {
    let derivedSeed;
    try {
      derivedSeed = ed25519.derivePath(path, seed.toString('hex')).key;
    } catch (e) {
      if (e.message.includes('Invalid derivation path')) {
        return null;
      }
      throw e;
    }
    const keypair = Keypair.fromSeed(derivedSeed.slice(0, 32));
    const address = keypair.publicKey.toBase58();

    const [txList, balance] = await Promise.all([
      retryWithBackoff(() => connection.getSignaturesForAddress(new PublicKey(address), { limit: 1 })),
      retryWithBackoff(() => connection.getBalance(new PublicKey(address)))
    ]);

    if (txList.length > 0 || balance > 0) {
      const burnInfo = await calculateBurnCost(address);
      return {
        path,
        address,
        privateKey: bs58.encode(Buffer.from(keypair.secretKey)),
        balance: balance / 1e9,
        hasTransactions: txList.length > 0,
        ...burnInfo
      };
    }
  } catch (error) {
    console.error(`⚠️ Error in path ${path}:`, error.message);
  }
  return null;
}

async function scanWallet(mnemonic, chatId) {
  if (!bip39.validateMnemonic(mnemonic)) {
    return bot.sendMessage(chatId, "❌ المنيمونك غير صالح!");
  }

  const BATCH_SIZE = 20;
  let consecutiveEmpty = 0;
  const MAX_CONSECUTIVE_EMPTY = 10;
  const seenAddresses = new Set();
  const pathGenerator = generatePaths();
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const userMode = userModes.get(chatId) || 'normal';
  let foundWalletsWithBalance = 0;

  if (userMode === 'balance_only') {
    await bot.sendMessage(chatId, '🔍 جاري البحث عن المحافظ التي تحتوي على رصيد SOL...');
  } else {
    await bot.sendMessage(chatId, '🔍 جاري البحث عن المحافظ النشطة...');
  }

  while (consecutiveEmpty < MAX_CONSECUTIVE_EMPTY) {
    const batchPaths = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const { value: path, done } = pathGenerator.next();
      if (done) break;
      batchPaths.push(path);
    }

    const results = await Promise.all(batchPaths.map(path => scanDerivationPath(path, seed)));
    let foundInBatch = 0;

    for (const wallet of results) {
      if (wallet && !seenAddresses.has(wallet.address)) {
        seenAddresses.add(wallet.address);

        if (userMode === 'balance_only') {
          // عرض المحافظ التي بها رصيد فقط
          if (wallet.balance > 0) {
            foundInBatch++;
            foundWalletsWithBalance++;

            const message = 
              `💰 محفظة بها رصيد!\n\n` +
              `📍 Path:\n${wallet.path}\n\n` +
              `🔑 Address:\n${wallet.address}\n\n` +
              `🔐 Private Key:\n${wallet.privateKey}\n\n` +
              `💰 Balance: ${wallet.balance} SOL\n\n` +
              `🔥 Expected SOL after burning: ${wallet.totalBurnCost} SOL`;

            await bot.sendMessage(chatId, message);
          } else if (wallet.hasTransactions) {
            // حساب المحافظ النشطة حتى لو لم يكن بها رصيد
            foundInBatch++;
          }
        } else {
          // الوضع العادي - عرض جميع المحافظ النشطة
          foundInBatch++;
          if (wallet.balance > 0) {
            foundWalletsWithBalance++;
          }

          const message = 
            `🎁 ${wallet.balance > 0 ? 'Has balance' : 'Active without balance'}\n\n` +
            `📍 Path:\n${wallet.path}\n\n` +
            `🔑 Address:\n${wallet.address}\n\n` +
            `🔐 Private Key:\n${wallet.privateKey}\n\n` +
            `💰 Balance: ${wallet.balance} SOL\n\n` +
            `🔥 Expected SOL after burning: ${wallet.totalBurnCost} SOL`;

          await bot.sendMessage(chatId, message);
        }
      }
    }

    if (foundInBatch === 0) {
      consecutiveEmpty += BATCH_SIZE;
      if (consecutiveEmpty % 50 === 0) {
        await bot.sendMessage(chatId, `🔍 جاري البحث... (${consecutiveEmpty} مسار فارغ)`);
      }
    } else {
      consecutiveEmpty = 0;
    }
  }

  if (userMode === 'balance_only') {
    if (foundWalletsWithBalance === 0) {
      await bot.sendMessage(chatId, '✅ اكتمل البحث! لم يتم العثور على أي محافظ تحتوي على رصيد SOL.');
    } else {
      await bot.sendMessage(chatId, `✅ اكتمل البحث! تم العثور على ${foundWalletsWithBalance} محفظة تحتوي على رصيد.`);
    }
  } else {
    await bot.sendMessage(chatId, '✅ اكتمل البحث!');
  }
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    'مرحباً! 👋\n\n' +
    '🔑 أرسل لي المنيمونك الخاص بك وسأقوم بفحص المحفظة.\n\n' +
    '💼 أو أرسل لي مفتاح خاص وسأعرض لك عنوان المحفظة والرصيد.\n\n' +
    '🎲 استخدم /starts لتوليد عبارات سرية عشوائية.\n\n' +
    '💰 استخدم /b للتبديل بين وضع عرض جميع المحافظ أو المحافظ ذات الرصيد فقط.'
  );
});

bot.onText(/\/b$/, (msg) => {
  const chatId = msg.chat.id;
  const currentMode = userModes.get(chatId) || 'normal';

  if (currentMode === 'normal') {
    userModes.set(chatId, 'balance_only');
    bot.sendMessage(chatId, 
      '💰 تم تفعيل وضع المحافظ ذات الرصيد فقط!\n\n' +
      '🔑 أرسل الآن الكلمات السرية وسيتم عرض المحافظ التي بها رصيد SOL فقط.\n\n' +
      '🔄 استخدم /b مرة أخرى للعودة للوضع العادي.'
    );
  } else {
    userModes.set(chatId, 'normal');
    bot.sendMessage(chatId, 
      '🔄 تم العودة للوضع العادي!\n\n' +
      '🔑 سيتم الآن عرض جميع المحافظ النشطة (بها رصيد وبدون رصيد).\n\n' +
      '💰 استخدم /b للتحويل لوضع المحافظ ذات الرصيد فقط.'
    );
  }
});

bot.onText(/\/starts/, async (msg) => {
  const chatId = msg.chat.id;
  let message = '🎲 إليك 10 عبارات سرية شائعة:\n\n';

  for (let i = 0; i < 10; i++) {
    const mnemonic = bip39.generateMnemonic();
    const messageId = await bot.sendMessage(
      chatId, 
      `\`${mnemonic}\``, 
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔍 فحص العبارة', callback_data: `check_${i}` }
          ]]
        }
      }
    );
    global.mnemonics = global.mnemonics || {};
    global.mnemonics[i] = mnemonic;
  }
});

bot.on('callback_query', async (query) => {
  if (query.data.startsWith('check_')) {
    const index = query.data.replace('check_', '');
    const mnemonic = global.mnemonics[index];
    await bot.answerCallbackQuery(query.id);
    await scanWallet(mnemonic, query.message.chat.id);
  }
});

async function checkPrivateKey(privateKey, chatId) {
  try {
    // التحقق من صحة المفتاح الخاص
    let keypair;
    try {
      const secretKey = bs58.decode(privateKey);
      if (secretKey.length !== 64) {
        throw new Error('Invalid key length');
      }
      keypair = Keypair.fromSecretKey(secretKey);
    } catch (error) {
      await bot.sendMessage(chatId, "❌ المفتاح الخاص غير صالح!");
      return;
    }

    const address = keypair.publicKey.toBase58();
    const userMode = userModes.get(chatId) || 'normal';

    await bot.sendMessage(chatId, '🔍 جاري التحقق من المحفظة...');

    // الحصول على الرصيد
    const balance = await retryWithBackoff(() => 
      connection.getBalance(new PublicKey(address))
    );

    const balanceInSol = balance / 1e9;

    // في وضع المحافظ ذات الرصيد فقط، لا نعرض المحفظة إذا لم يكن بها رصيد
    if (userMode === 'balance_only' && balanceInSol === 0) {
      await bot.sendMessage(chatId, '❌ هذه المحفظة لا تحتوي على رصيد SOL.');
      return;
    }

    // حساب تكلفة الحرق
    const burnInfo = await calculateBurnCost(address);

    const message = 
      `💼 معلومات المحفظة:\n\n` +
      `🔑 العنوان:\n${address}\n\n` +
      `🔐 المفتاح الخاص:\n${privateKey}\n\n` +
      `💰 الرصيد: ${balanceInSol.toFixed(9)} SOL\n\n` +
      `🔥 تكلفة الحرق المتوقعة: ${burnInfo.totalBurnCost} SOL\n\n` +
      `📊 التفاصيل:\n` +
      `• الرموز الفارغة: ${burnInfo.emptyTokens}\n` +
      `• NFTs: ${burnInfo.nfts}`;

    await bot.sendMessage(chatId, message);

  } catch (error) {
    console.error("Error checking private key:", error);
    await bot.sendMessage(chatId, "❌ حدث خطأ أثناء التحقق من المحفظة.");
  }
}

function extractSolflareArray(text) {
  // البحث عن مصفوفة أرقام Solflare
  const arrayPattern = /\[(\s*\d+\s*(?:,\s*\d+\s*)*)\]/g;
  const matches = text.match(arrayPattern);

  if (matches) {
    for (const match of matches) {
      try {
        // إزالة الأقواس المربعة واستخراج الأرقام
        const numbersStr = match.slice(1, -1);
        const numbers = numbersStr.split(',').map(num => parseInt(num.trim()));

        // التحقق من أن المصفوفة تحتوي على 64 رقم (512 بت)
        if (numbers.length === 64 && numbers.every(num => num >= 0 && num <= 255)) {
          // تحويل إلى Buffer ثم إلى Base58
          const secretKeyBuffer = new Uint8Array(numbers);
          return bs58.encode(secretKeyBuffer);
        }
      } catch (error) {
        continue;
      }
    }
  }

  return null;
}

function extractAllPrivateKeys(text) {
  const privateKeys = [];

  // أولاً البحث عن مصفوفات Solflare
  const arrayPattern = /\[(\s*\d+\s*(?:,\s*\d+\s*)*)\]/g;
  let arrayMatch;
  while ((arrayMatch = arrayPattern.exec(text)) !== null) {
    try {
      const numbersStr = arrayMatch[1];
      const numbers = numbersStr.split(',').map(num => parseInt(num.trim()));

      if (numbers.length === 64 && numbers.every(num => num >= 0 && num <= 255)) {
        const secretKeyBuffer = new Uint8Array(numbers);
        const privateKey = bs58.encode(secretKeyBuffer);
        privateKeys.push(privateKey);
      }
    } catch (error) {
      continue;
    }
  }

  // البحث عن مفاتيح خاصة في الكلمات
  const words = text.split(/\s+/);
  for (const word of words) {
    try {
      const decoded = bs58.decode(word);
      if (decoded.length === 64 && !privateKeys.includes(word)) {
        privateKeys.push(word);
      }
    } catch (error) {
      continue;
    }
  }

  // البحث عن نمط المفتاح الخاص باستخدام regex
  const base58Pattern = /[1-9A-HJ-NP-Za-km-z]{87,88}/g;
  let regexMatch;
  while ((regexMatch = base58Pattern.exec(text)) !== null) {
    try {
      const decoded = bs58.decode(regexMatch[0]);
      if (decoded.length === 64 && !privateKeys.includes(regexMatch[0])) {
        privateKeys.push(regexMatch[0]);
      }
    } catch (error) {
      continue;
    }
  }

  return privateKeys;
}

function extractAllMnemonics(text) {
  const mnemonics = [];
  const words = text.toLowerCase().split(/\s+/);
  const mnemonicWordList = bip39.wordlists.english;
  const usedIndices = new Set();

  // البحث عن 12 أو 24 كلمة متتالية من قائمة BIP39
  for (let i = 0; i <= words.length - 12; i++) {
    if (usedIndices.has(i)) continue;

    // فحص 24 كلمة أولاً
    if (i <= words.length - 24) {
      const twentyFourWords = words.slice(i, i + 24);
      if (twentyFourWords.every(word => mnemonicWordList.includes(word))) {
        const candidateMnemonic = twentyFourWords.join(' ');
        if (bip39.validateMnemonic(candidateMnemonic)) {
          mnemonics.push(candidateMnemonic);
          // تسجيل الفهارس المستخدمة
          for (let j = i; j < i + 24; j++) {
            usedIndices.add(j);
          }
          continue;
        }
      }
    }

    // فحص 12 كلمة
    const twelveWords = words.slice(i, i + 12);
    if (twelveWords.every(word => mnemonicWordList.includes(word))) {
      const candidateMnemonic = twelveWords.join(' ');
      if (bip39.validateMnemonic(candidateMnemonic)) {
        mnemonics.push(candidateMnemonic);
        // تسجيل الفهارس المستخدمة
        for (let j = i; j < i + 12; j++) {
          usedIndices.add(j);
        }
      }
    }
  }

  return mnemonics;
}

bot.on('message', async (msg) => {
  if (msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;

  // البحث عن جميع المفاتيح الخاصة في النص
  const privateKeys = extractAllPrivateKeys(msg.text);

  // البحث عن جميع الكلمات السرية في النص
  const mnemonics = extractAllMnemonics(msg.text);

  // إذا وُجدت مفاتيح خاصة، فحصها جميعاً
  if (privateKeys.length > 0) {
    if (privateKeys.length > 1) {
      await bot.sendMessage(chatId, `🔍 تم العثور على ${privateKeys.length} مفاتيح خاصة، جاري فحصها...`);
    }

    for (let i = 0; i < privateKeys.length; i++) {
      if (privateKeys.length > 1) {
        await bot.sendMessage(chatId, `📝 فحص المفتاح ${i + 1}/${privateKeys.length}:`);
      }
      await checkPrivateKey(privateKeys[i], chatId);
    }
  }

  // إذا وُجدت كلمات سرية، فحصها جميعاً
  if (mnemonics.length > 0) {
    if (mnemonics.length > 1) {
      await bot.sendMessage(chatId, `🔍 تم العثور على ${mnemonics.length} مجموعات كلمات سرية، جاري فحصها...`);
    }

    for (let i = 0; i < mnemonics.length; i++) {
      if (mnemonics.length > 1) {
        await bot.sendMessage(chatId, `📝 فحص الكلمات السرية ${i + 1}/${mnemonics.length}:`);
      }
      await bot.sendMessage(chatId, `🔍 الكلمات السرية: "${mnemonics[i]}"`);
      await scanWallet(mnemonics[i], chatId);
    }
  }

  // إذا لم يوجد أي منهما، محاولة التعامل مع النص كما هو (للتوافق مع النسخة القديمة)
  if (privateKeys.length === 0 && mnemonics.length === 0) {
    await scanWallet(msg.text, chatId);
  }
});

// إزالة الـ webhook والاعتماد على polling فقط
console.log('🤖 بوت تلجرام قيد التشغيل...');
console.log('📡 يستخدم polling mode للاتصال مع تلجرام');

// التأكد من إزالة أي webhook سابق
(async () => {
  try {
    await bot.deleteWebHook();
    console.log('✅ تم إزالة الـ webhook بنجاح');
  } catch (error) {
    console.log('ℹ️ لا يوجد webhook ليتم إزالته');
  }
})();
const http = require('http');
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('🤖 Telegram bot is running.\n');
}).listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});
