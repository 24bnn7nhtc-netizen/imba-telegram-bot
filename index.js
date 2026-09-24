const { getHistoricalRates } = require("dukascopy-node");

const INSTRUMENT = "xauusd";

const TIMEFRAME = "m5";

// ================================

// PARAMÈTRES IMBA

// ================================

const SENSITIVITY = 20;

// SL à 50 % de la distance entre

// l'entrée et le niveau Fibonacci

const SL_MULTIPLIER = 0.50;

const TP1_PERCENT = 0.0050; // 0,50 %

const TP2_PERCENT = 0.0075; // 0,75 %

const TP3_PERCENT = 0.0100; // 1,00 %

const TP4_PERCENT = 0.0125; // 1,25 %

const TICK_SIZE = 0.01;

// ================================

// TELEGRAM

// ================================

const TELEGRAM_CHAT_ID = "1461681427";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// ================================

// GITHUB

// ================================

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;

const STATE_FILE = "state.json";

// ================================

// PRIX

// ================================

function roundToTick(price) {

    return Math.round(price / TICK_SIZE) * TICK_SIZE;

}

function roundPrice(price) {

    return roundToTick(price).toFixed(2);

}

// ================================

// TELEGRAM

// ================================

async function sendTelegram(message) {

    if (!TELEGRAM_TOKEN) {

        throw new Error("TELEGRAM_BOT_TOKEN manquant.");

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

        throw new Error(

            `Erreur Telegram: ${JSON.stringify(data)}`

        );

    }

    console.log("Message Telegram envoyé.");

}

// ================================

// ÉTAT GITHUB

// ================================

async function getState() {

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

        console.log(

            "state.json introuvable : initialisation."

        );

        return {

            trend: null,

            lastProcessedTimestamp: 0,

            lastSignalTimestamp: 0,

            sha: null

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

}

// ================================

// SAUVEGARDE ÉTAT

// ================================

async function saveState(state) {

    const content = JSON.stringify(

        {

            trend: state.trend,

            lastProcessedTimestamp:

                state.lastProcessedTimestamp,

            lastSignalTimestamp:

                state.lastSignalTimestamp

        },

        null,

        2

    );

    const body = {

        message: "Update IMBA bot state",

        content: Buffer

            .from(content)

            .toString("base64"),

        branch: "main"

    };

    if (state.sha) {

        body.sha = state.sha;

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

            `Erreur sauvegarde state.json: ${errorText}`

        );

    }

    console.log("État sauvegardé.");

}

// ================================

// BOUGIES

// ================================

async function getCandles() {

    const now = new Date();

    // 7 jours permettent de reconstruire

    // correctement le contexte initial.

    const from = new Date(

        now.getTime() -

        7 * 24 * 60 * 60 * 1000

    );

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

        throw new Error(

            "Aucune donnée XAUUSD reçue."

        );

    }

    // Bougie M5 actuellement en formation

    // exclue du calcul.

    const currentFiveMinute =

        Math.floor(

            Date.now() / (5 * 60 * 1000)

        ) * (5 * 60 * 1000);

    return data

        .filter(

            candle =>

                candle.timestamp <

                currentFiveMinute

        )

        .sort(

            (a, b) =>

                a.timestamp - b.timestamp

        );

}

// ================================

// HIGHEST / LOWEST

// ================================

function highest(candles, index, length) {

    let value = -Infinity;

    const start =

        index - length + 1;

    for (

        let i = start;

        i <= index;

        i++

    ) {

        if (i >= 0) {

            value = Math.max(

                value,

                candles[i].high

            );

        }

    }

    return value;

}

function lowest(candles, index, length) {

    let value = Infinity;

    const start =

        index - length + 1;

    for (

        let i = start;

        i <= index;

        i++

    ) {

        if (i >= 0) {

            value = Math.min(

                value,

                candles[i].low

            );

        }

    }

    return value;

}

// ================================

// CALCUL IMBA

// ================================

function calculateLevels(

    candles,

    index

) {

    const highLine =

        highest(

            candles,

            index,

            SENSITIVITY

        );

    const lowLine =

        lowest(

            candles,

            index,

            SENSITIVITY

        );

    const channelRange =

        highLine - lowLine;

    const fib236 =

        highLine -

        channelRange * 0.236;

    const fib5 =

        highLine -

        channelRange * 0.5;

    const fib786 =

        highLine -

        channelRange * 0.786;

    return {

        highLine,

        lowLine,

        fib236,

        fib5,

        fib786

    };

}

// ================================

// TRAITEMENT DES BOUGIES

// ================================

function processCandles(

    candles,

    state

) {

    let trend = state.trend;

    let signal = null;

    // Première initialisation :

    // on reconstruit le contexte historique

    // MAIS on n'envoie aucun ancien signal.

    const isFirstRun =

        !state.lastProcessedTimestamp;

    let startIndex =

        SENSITIVITY - 1;

    if (!isFirstRun) {

        startIndex =

            candles.findIndex(

                candle =>

                    candle.timestamp >

                    state.lastProcessedTimestamp

            );

        if (startIndex === -1) {

            return {

                state,

                signal: null

            };

        }

    }

    for (

        let i = startIndex;

        i < candles.length;

        i++

    ) {

        const candle = candles[i];

        if (i < SENSITIVITY - 1) {

            continue;

        }

        const levels =

            calculateLevels(

                candles,

                i

            );

        const {

            fib236,

            fib5,

            fib786

        } = levels;

        const canLong =

            candle.close >= fib5 &&

            candle.close >= fib236 &&

            trend !== "LONG";

        const canShort =

            candle.close <= fib5 &&

            candle.close <= fib786 &&

            trend !== "SHORT";

        // ============================

        // LONG

        // ============================

        if (canLong) {

            trend = "LONG";

            // Sur la première initialisation,

            // on ne crée pas d'alerte historique.

            if (!isFirstRun) {

                const entry =

                    candle.close;

                const rawSL =

                    fib786;

                const sl =

                    entry -

                    (

                        entry - rawSL

                    ) * SL_MULTIPLIER;

                signal = {

                    side: "LONG",

                    timestamp:

                        candle.timestamp,

                    entry:

                        roundToTick(entry),

                    sl:

                        roundToTick(sl),

                    tp1:

                        roundToTick(

                            entry *

                            (1 + TP1_PERCENT)

                        ),

                    tp2:

                        roundToTick(

                            entry *

                            (1 + TP2_PERCENT)

                        ),

                    tp3:

                        roundToTick(

                            entry *

                            (1 + TP3_PERCENT)

                        ),

                    tp4:

                        roundToTick(

                            entry *

                            (1 + TP4_PERCENT)

                        )

                };

            }

        }

        // ============================

        // SHORT

        // ============================

        else if (canShort) {

            trend = "SHORT";

            if (!isFirstRun) {

                const entry =

                    candle.close;

                const rawSL =

                    fib236;

                const sl =

                    entry +

                    (

                        rawSL - entry

                    ) * SL_MULTIPLIER;

                signal = {

                    side: "SHORT",

                    timestamp:

                        candle.timestamp,

                    entry:

                        roundToTick(entry),

                    sl:

                        roundToTick(sl),

                    tp1:

                        roundToTick(

                            entry *

                            (1 - TP1_PERCENT)

                        ),

                    tp2:

                        roundToTick(

                            entry *

                            (1 - TP2_PERCENT)

                        ),

                    tp3:

                        roundToTick(

                            entry *

                            (1 - TP3_PERCENT)

                        ),

                    tp4:

                        roundToTick(

                            entry *

                            (1 - TP4_PERCENT)

                        )

                };

            }

        }

    }

    state.trend = trend;

    state.lastProcessedTimestamp =

        candles[candles.length - 1]

            .timestamp;

    if (signal) {

        state.lastSignalTimestamp =

            signal.timestamp;

    }

    return {

        state,

        signal

    };

}

// ================================

// MESSAGE TELEGRAM

// ================================

function formatTelegram(signal) {

    const emoji =

        signal.side === "LONG"

            ? "🟢"

            : "🔴";

    return `${emoji} IMBA ALGO — ${signal.side}

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

// ================================

// PROGRAMME

// ================================

async function main() {

    console.log(

        "================================"

    );

    console.log(

        "IMBA TELEGRAM BOT"

    );

    console.log(

        "XAUUSD M5"

    );

    console.log(

        "================================"

    );

    const candles =

        await getCandles();

    console.log(

        `${candles.length} bougies M5 récupérées.`

    );

    const state =

        await getState();

    console.log(

        "Tendance mémorisée :",

        state.trend || "AUCUNE"

    );

    const result =

        processCandles(

            candles,

            state

        );

    if (!result.signal) {

        await saveState(

            result.state

        );

        console.log(

            "Aucune nouvelle entrée IMBA."

        );

        return;

    }

    const signal =

        result.signal;

    console.log(

        "NOUVEAU SIGNAL :",

        signal.side,

        new Date(

            signal.timestamp

        ).toISOString()

    );

    const message =

        formatTelegram(signal);

    await sendTelegram(message);

    await saveState(

        result.state

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