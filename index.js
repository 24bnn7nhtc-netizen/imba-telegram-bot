const { getHistoricalRates } = require("dukascopy-node");

const INSTRUMENT = "xauusd";

const TIMEFRAME = "m5";

// ===== PARAMÈTRES IMBA =====

const SENSITIVITY = 20;

const SL_MULTIPLIER = 0.50;

const TP1_PERCENT = 0.0050; // 0,50 %

const TP2_PERCENT = 0.0075; // 0,75 %

const TP3_PERCENT = 0.0100; // 1,00 %

const TP4_PERCENT = 0.0125; // 1,25 %

const TICK_SIZE = 0.01;

// Telegram

const TELEGRAM_CHAT_ID = "1461681427";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// GitHub

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;

// Fichier utilisé pour éviter les doublons Telegram

const STATE_FILE = "state.json";

// ---------------------------------------------------------

// ARRONDI AU TICK SIZE

// ---------------------------------------------------------

function roundToTick(price) {

    return Math.round(price / TICK_SIZE) * TICK_SIZE;

}

function roundPrice(price) {

    return roundToTick(price).toFixed(2);

}

// ---------------------------------------------------------

// TÉLÉGRAM

// ---------------------------------------------------------

async function sendTelegram(message) {

    if (!TELEGRAM_TOKEN) {

        throw new Error("TELEGRAM_BOT_TOKEN n'est pas configuré.");

    }

    const response = await fetch(

        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,

        {

            method: "POST",

            headers: {

                "Content-Type": "application/json"

            },

            body: JSON.stringify({

                chat_id: TELEGRAM_CHAT_ID,

                text: message

            })

        }

    );

    const data = await response.json();

    if (!data.ok) {

        throw new Error(`Erreur Telegram: ${JSON.stringify(data)}`);

    }

    console.log("Message Telegram envoyé.");

}

// ---------------------------------------------------------

// RÉCUPÉRATION DES BOUGIES

// ---------------------------------------------------------

async function getCandles() {

    const now = new Date();

    // On récupère environ 24 heures de M5.

    // Cela donne largement plus que les 20 bougies nécessaires.

    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const data = await getHistoricalRates({

        instrument: INSTRUMENT,

        dates: {

            from,

            to: now

        },

        timeframe: TIMEFRAME,

        format: "json"

    });

    if (!data || data.length === 0) {

        throw new Error("Aucune donnée XAUUSD reçue.");

    }

    // On ne travaille que sur les bougies déjà clôturées.

    const currentFiveMinute =

        Math.floor(Date.now() / (5 * 60 * 1000)) * (5 * 60 * 1000);

    const closedCandles = data

        .filter(candle => candle.timestamp < currentFiveMinute)

        .sort((a, b) => a.timestamp - b.timestamp);

    return closedCandles;

}

// ---------------------------------------------------------

// PLUS HAUT / PLUS BAS SUR "SENSITIVITY" BOUGIES

// ---------------------------------------------------------

function highest(candles, endIndex, length) {

    let value = -Infinity;

    const start = Math.max(0, endIndex - length + 1);

    for (let i = start; i <= endIndex; i++) {

        value = Math.max(value, candles[i].high);

    }

    return value;

}

function lowest(candles, endIndex, length) {

    let value = Infinity;

    const start = Math.max(0, endIndex - length + 1);

    for (let i = start; i <= endIndex; i++) {

        value = Math.min(value, candles[i].low);

    }

    return value;

}

// ---------------------------------------------------------

// CALCUL IMBA

// ---------------------------------------------------------

function calculateSignal(candles) {

    if (candles.length < SENSITIVITY + 2) {

        return null;

    }

    let isLongTrend = false;

    let isShortTrend = false;

    let latestSignal = null;

    for (let i = SENSITIVITY - 1; i < candles.length; i++) {

        const candle = candles[i];

        const highLine = highest(candles, i, SENSITIVITY);

        const lowLine = lowest(candles, i, SENSITIVITY);

        const channelRange = highLine - lowLine;

        const fib236 =

            highLine - channelRange * 0.236;

        const fib382 =

            highLine - channelRange * 0.382;

        const fib5 =

            highLine - channelRange * 0.5;

        const fib618 =

            highLine - channelRange * 0.618;

        const fib786 =

            highLine - channelRange * 0.786;

        const imbaTrendLine = fib5;

        let canLong =

            candle.close >= imbaTrendLine &&

            candle.close >= fib236 &&

            !isLongTrend;

        let canShort =

            candle.close <= imbaTrendLine &&

            candle.close <= fib786 &&

            !isShortTrend;

        // Même logique de changement de tendance

        if (canLong) {

            isLongTrend = true;

            isShortTrend = false;

            const entry = candle.close;

            // SL = distance Fibonacci réduite à 50 %

            const rawSL = fib786;

            const sl =

                entry -

                (entry - rawSL) * SL_MULTIPLIER;

            const signal = {

                side: "LONG",

                timestamp: candle.timestamp,

                entry: roundToTick(entry),

                sl: roundToTick(sl),

                tp1: roundToTick(

                    entry * (1 + TP1_PERCENT)

                ),

                tp2: roundToTick(

                    entry * (1 + TP2_PERCENT)

                ),

                tp3: roundToTick(

                    entry * (1 + TP3_PERCENT)

                ),

                tp4: roundToTick(

                    entry * (1 + TP4_PERCENT)

                )

            };

            latestSignal = signal;

        } else if (canShort) {

            isShortTrend = true;

            isLongTrend = false;

            const entry = candle.close;

            // Pour un SHORT, le SL vient de Fibonacci 236

            const rawSL = fib236;

            const sl =

                entry +

                (rawSL - entry) * SL_MULTIPLIER;

            const signal = {

                side: "SHORT",

                timestamp: candle.timestamp,

                entry: roundToTick(entry),

                sl: roundToTick(sl),

                tp1: roundToTick(

                    entry * (1 - TP1_PERCENT)

                ),

                tp2: roundToTick(

                    entry * (1 - TP2_PERCENT)

                ),

                tp3: roundToTick(

                    entry * (1 - TP3_PERCENT)

                ),

                tp4: roundToTick(

                    entry * (1 - TP4_PERCENT)

                )

            };

            latestSignal = signal;

        } else {

            canLong = false;

            canShort = false;

        }

    }

    return latestSignal;

}

// ---------------------------------------------------------

// LECTURE DU DERNIER SIGNAL ENVOYÉ

// ---------------------------------------------------------

async function getState() {

    try {

        const response = await fetch(

            `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${STATE_FILE}`,

            {

                headers: {

                    "Authorization": `Bearer ${GITHUB_TOKEN}`,

                    "Accept": "application/vnd.github+json"

                }

            }

        );

        if (!response.ok) {

            return {

                lastSignalTimestamp: 0

            };

        }

        const data = await response.json();

        const content = Buffer

            .from(data.content, "base64")

            .toString("utf8");

        return {

            ...JSON.parse(content),

            sha: data.sha

        };

    } catch (error) {

        console.log("État initial.");

        return {

            lastSignalTimestamp: 0

        };

    }

}

// ---------------------------------------------------------

// SAUVEGARDE DU DERNIER SIGNAL

// ---------------------------------------------------------

async function saveState(timestamp, sha = null) {

    const content = JSON.stringify(

        {

            lastSignalTimestamp: timestamp

        },

        null,

        2

    );

    const body = {

        message: `Update signal state`,

        content: Buffer

            .from(content)

            .toString("base64"),

        branch: "main"

    };

    if (sha) {

        body.sha = sha;

    }

    const response = await fetch(

        `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${STATE_FILE}`,

        {

            method: "PUT",

            headers: {

                "Authorization": `Bearer ${GITHUB_TOKEN}`,

                "Accept": "application/vnd.github+json",

                "Content-Type": "application/json"

            },

            body: JSON.stringify(body)

        }

    );

    if (!response.ok) {

        const errorText = await response.text();

        throw new Error(

            `Impossible de sauvegarder state.json: ${errorText}`

        );

    }

    console.log("État sauvegardé.");

}

// ---------------------------------------------------------

// FORMAT TELEGRAM

// ---------------------------------------------------------

function formatTelegram(signal) {

    const emoji =

        signal.side === "LONG"

            ? "🟢"

            : "🔴";

    const direction =

        signal.side === "LONG"

            ? "LONG"

            : "SHORT";

    return `${emoji} IMBA ALGO — ${direction}

💰 Entrée : ${roundPrice(signal.entry)}

🛑 SL : ${roundPrice(signal.sl)}

🎯 TP1 : ${roundPrice(signal.tp1)}

🎯 TP2 : ${roundPrice(signal.tp2)}

🎯 TP3 : ${roundPrice(signal.tp3)}

🎯 TP4 : ${roundPrice(signal.tp4)}

📊 XAUUSD — M5

⚙️ Sensibilité : 20

🛑 SL distance : 50 %

TP :

0,50 % / 0,75 % / 1,00 % / 1,25 %`;

}

// ---------------------------------------------------------

// PROGRAMME PRINCIPAL

// ---------------------------------------------------------

async function main() {

    console.log("================================");

    console.log("IMBA TELEGRAM BOT");

    console.log("XAUUSD M5");

    console.log("================================");

    if (!TELEGRAM_TOKEN) {

        throw new Error(

            "Le secret TELEGRAM_BOT_TOKEN est manquant."

        );

    }

    const candles = await getCandles();

    console.log(

        `${candles.length} bougies M5 récupérées.`

    );

    const lastCandle =

        candles[candles.length - 1];

    console.log(

        "Dernière bougie clôturée :",

        new Date(lastCandle.timestamp).toISOString()

    );

    const signal = calculateSignal(candles);

    if (!signal) {

        console.log(

            "Aucun signal détecté."

        );

        return;

    }

    console.log(

        "Dernier signal :",

        signal.side,

        new Date(signal.timestamp).toISOString()

    );

    const state = await getState();

    // Évite d'envoyer plusieurs fois le même signal

    if (

        Number(state.lastSignalTimestamp) ===

        Number(signal.timestamp)

    ) {

        console.log(

            "Signal déjà envoyé. Aucun doublon."

        );

        return;

    }

    const message =

        formatTelegram(signal);

    await sendTelegram(message);

    await saveState(

        signal.timestamp,

        state.sha || null

    );

    console.log(

        "Signal envoyé avec succès."

    );

}

main().catch(error => {

    console.error(

        "ERREUR :",

        error

    );

    process.exit(1);

});
