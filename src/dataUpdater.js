const express = require('express');
const data = require('./data');
const request = require('request');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const router = express.Router();
const mailer = require('./mailer');
const reportGenerator = require('./reportGenerator');
const blizzard  = require('blizzard.js').initialize({
    key: process.env.WOW_API_CLIENTID,
    secret: process.env.WOW_API_CLIENTSECRET,
    origin: 'us',
});
var blizzardToken = '';
blizzard.getApplicationToken({
    key: process.env.WOW_API_CLIENTID,
    secret: process.env.WOW_API_CLIENTSECRET,
    origin: 'us'
}).then(response => {
    blizzardToken = response.data.access_token;
}).catch(e => {
    console.error(e)
    mailer.error(e);
});
const guildRealm = 'frostmourne';
const guildRegion = 'us';

// updates/adds a character in/to the database with new data from battle.net
function updateCharacter(charName) {
    blizzard.wow.character(['profile'], { 
        origin: guildRegion, 
        realm: guildRealm, 
        name: charName, 
        token: blizzardToken 
    }).then(response => {
        const sql = 'SELECT id FROM characters WHERE name=? COLLATE NOCASE;';
        data.db.get(sql, [charName], function(err, row) {
            const sql = `INSERT OR REPLACE INTO characters(
                id,
                lastModified,
                name,
                class,
                thumbnail) VALUES(?, ?, ?, ?, ?);`;
            let params = [
                row ? row.id : null,
                response.data.lastModified,
                response.data.name,
                response.data.class,
                response.data.thumbnail,
            ];
            data.db.run(sql, params);
        })
    }).catch(e => { 
        console.error(`Error updating ${charName}`, e);
        mailer.error(e);
    });
}

// updates every character in the database with new data from battle.net
function updateAllCharacters() {
    const sql = 'SELECT name FROM characters;';
    data.db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Failed to "SELECT * FROM characters":', err);
            mailer.error(err);
        }
        for (var i = 0; i < rows.length; i++) {
            console.log(`Updating character: ${rows[i].name}`);
            updateCharacter(rows[i].name);
        }
    });
}

// runs a raidbots sim for the given character
async function runSim(charName) {
    mailer.log(`Starting new sim for character ${charName}`);
    console.log(`Starting new sim: ${charName}`);
    const uri = `https://www.raidbots.com/simbot/droptimizer?region=${guildRegion}&realm=${guildRealm}&name=${charName}`;
    const cookies = [{
        name: 'raidsid',
        value: process.env.RAIDBOTS_COOKIE,
        domain: 'www.raidbots.com',
    }];

    // get a new page
    const browser = await puppeteer.launch().catch(function(e) {
        console.error('Failed to start a new browser');
        mailer.error(e);
    });
    if (browser) {
        const page = await browser.newPage().catch(function(e) {
            console.error('Failed to open a new page');
            mailer.error(e);
        });
        if (page) {
            await page.setCookie(...cookies).catch((e) => { console.error(e); mailer.error(e); });
            await page.goto(uri).catch((e) => { console.error(e); mailer.error(e); });
            setTimeout(async function() { // let raidbots have 3 secs to set up the page
                // select BoD
                await page.click('#app > div > div.Container > section > section > div:nth-child(2) > section > div:nth-child(3) > div:nth-child(2) > div:nth-child(2) > div > div:nth-child(3) > div').catch((e) => { console.error(e); mailer.error(e); });
                // select mythic
                await page.click('#app > div > div.Container > section > section > div:nth-child(2) > section > div:nth-child(3) > div:nth-child(2) > div:nth-child(3) > div > div > div:nth-child(4)').catch((e) => { console.error(e); mailer.error(e); });
                // select 415 TF
                await page.click('#app > div > div.Container > section > section > div:nth-child(2) > section > div:nth-child(3) > div:nth-child(2) > div:nth-child(4) > div > div > div:nth-child(1)').catch((e) => { console.error(e); mailer.error(e); });
                // set reorigination array stacks to 0
                // open sim options
                //await page.click('#app > div > div.Container > section > section > div > section > div:nth-child(5) > div > label > div > div:nth-child(1) > div > div:nth-child(2)').catch((e) => { console.error(e); mailer.error(e); });
                // click the array stacks drop down
                //await page.click('#app > div > div.Container > section > section > div > section > div:nth-child(5) > div > div > div > div:nth-child(4) > div > div > div > div > div > select').catch((e) => { console.error(e); mailer.error(e); });
                // press down arrow to select 0 from dropdown
                //await page.keyboard.press('ArrowDown').catch((e) => { console.error(e); mailer.error(e); });
                // press enter to confirm selection
                //await page.keyboard.press('Enter').catch((e) => { console.error(e); mailer.error(e); });
                // start the sim, twice bc it doesnt work otherwise
                await page.click('#app > div > div.Container > section > section > div:nth-child(2) > section > div:nth-child(11) > div > div:nth-child(1) > button').catch((e) => { console.error(e); mailer.error(e); });
                //await page.click('#app > div > div.Container > section > section > div > section > div:nth-child(11) > div > div:nth-child(1) > button').catch((e) => { console.error(e); mailer.error(e); });
                await page.waitForNavigation().catch((e) => { console.error(e); mailer.error(e); });
                const reportID = page.url().split('/')[5];
                await page.close().catch((e) => { console.error(e); mailer.error(e); });
                await browser.close().catch((e) => { console.error(e); mailer.error(e); });
                setTimeout(function() { // let raidbots have 10 mins to process the sim
                    updateSimcReport(reportID);
                },1000 * 60 * 10); 
            }, 1000 * 3);
        }
    }
}

function runAllSims() {
    mailer.log('Starting new simulations for all characters');
    const delayGap = 60 * 1000 * 5; // 5 min delay between starting sims
    let lastDelay = 0;
    const sql = 'SELECT * FROM characters;';
    data.db.all(sql, [], (err, rows) => {
        if (err) {
            throw err;
        }
        for (let i = 0; i < rows.length; i++) {
            setTimeout(function() {
                runSim(rows[i].name, rows[i].realm, rows[i].region);
            }, lastDelay);
            lastDelay += delayGap;
        }
    });
}

function insertUpgrade(charID, result, baseDps, reportID, spec, timeStamp) {
    function _insertUpgrade(charID, result, baseDps, reportID, spec, timeStamp) {
        const nameParts = result.name.split('\/')
        const itemID = nameParts[2];
        const sql = `INSERT OR REPLACE INTO upgrades(
            characterID,
            itemID,
            reportID,
            dps,
            baseDps,
            spec,
            timeStamp) VALUES(?, ?, ?, ?, ?, ?, ?);`;
        const params = [
            charID,
            itemID,
            reportID,
            result.mean,
            baseDps.mean,
            spec,
            timeStamp
        ];
        // check if this item is an azerite piece
        // if it is we can have multiple results with the same item id
        if (nameParts.length === 6) { // azerite items have an extra part for their trait config
            data.db.get('SELECT * FROM upgrades WHERE characterID=? AND itemID=?;', [charID, itemID], function(err, row) {
                if (err) {
                    throw err;
                }
                if (row) {
                    // only insert the new data if it has a higher dps mean than the current
                    if (row.mean < result.mean) {
                        data.db.run(sql, params);
                    }
                } else {
                    data.db.run(sql, params);
                }
            });
        } else {
            data.db.run(sql, params);
        }
    }
    // bodge to ensure highest azerite dps is always used
    _insertUpgrade(charID, result, baseDps, reportID, spec, timeStamp);
    _insertUpgrade(charID, result, baseDps, reportID, spec, timeStamp);
}

function updateSimcReport(reportID) {
    // TODO: check if the report is a droptimier sim
    console.log(`Fetching raidbots report ${reportID}`);
    let uri = `https://www.raidbots.com/reports/${reportID}/data.json`;
    request.get(uri, function(error, response, body) {
        if (response && response.statusCode === 200) {
            let report = JSON.parse(body);
            let charName = report.simbot.meta.rawFormData.character.name;
            // delete all current upgrades for this report's character
            data.db.run('DELETE FROM upgrades WHERE characterID = (SELECT id FROM characters WHERE name = ?);', [charName]);
            console.log(`Parsing report: ${charName}`);
            // ensure the character is up to date
            updateCharacter(charName);
            // get the character id
            let sql = 'SELECT * FROM characters WHERE name=? COLLATE NOCASE;';
            data.db.get(sql, [charName], (err, row) => {
                if (err) {
                    throw err;
                }
                for (var i = 0; i < report.sim.profilesets.results.length; i++) {
                    insertUpgrade(row.id, 
                        report.sim.profilesets.results[i], 
                        report.sim.players[0].collected_data.dps, 
                        reportID, 
                        report.sim.players[0].specialization, 
                        report.simbot.date);
                }
            });
        } else {
            console.error(error);
            mailer.error(error);
        }
    });
}

// deletes upgrades that are over 2 days old
function pruneStaleUpgrades() {
    // FIXME: one is in ms the other in us
    data.db.run('DELETE FROM upgrades WHERE timeStamp <= date("now","-2 day");');
}

// updates item database with data from raidbots
function updateItems() {
    const uri = 'https://www.raidbots.com/static/data/live/equippable-items.json';
    request.get(uri, function(error, response, body) {
        if (response && response.statusCode === 200) {
            console.log('Got item data from raidbots');
            const items = JSON.parse(body);
            data.db.run("BEGIN TRANSACTION;");
            for (let i = 0; i < items.length; i++) {
                const sql = 'INSERT OR REPLACE INTO items(id, name, icon, quality, itemLevel) VALUES (?, ?, ?, ?, ?);'
                const params = [items[i].id, items[i].name, items[i].icon, items[i].quality, items[i].itemLevel];
                data.db.run(sql, params);
            }
            data.db.run("COMMIT TRANSACTION;");
            console.log(`${items.length} items updated`);
        } else {
            console.error(error);
            mailer.error(error);
        }
    });
}

// deletes a character from the database
function removeCharacter(charName) {
    data.db.run('DELETE FROM characters WHERE name=? COLLATE NOCASE;', [charName]);
}

async function firstStart() {
    // start cron jobs
    createCronJobs();

    // run everything once on first start
    setTimeout(function() { // wait 5 secs for battle.net api token
        updateCharacter('arwic'); 
        updateCharacter('bowbi'); 
        updateCharacter('monkaxd'); 
        updateCharacter('subjugates'); 
        updateCharacter('kharahh'); 
        updateCharacter('datspank'); 
        updateCharacter('astios'); 
        updateCharacter('solarhands'); 
        updateCharacter('gayke'); 
        updateCharacter('sadwoofer'); 
        updateCharacter('cleavergreen'); 
        updateCharacter('bwobets'); 
        updateCharacter('dasit'); 
        //updateCharacter('vietmonks'); 
        updateCharacter('Nivektis'); 
        updateCharacter('ptolemy'); 
        //updateCharacter('stollas'); 
        updateCharacter('agreatname'); 
        updateCharacter('kitteriel'); 
        updateCharacter('procreated'); 
        updateCharacter('bbltransfmnz'); 
        //updateCharacter('zezek'); 
        //updateCharacter('brbteabreaks'); 
        //updateCharacter('peroxíde'); 
        updateCharacter('solarburst'); 
        updateCharacter('tarana'); 
        updateCharacter('Frodolol'); 
        updateCharacter('Cpc'); 
        updateCharacter('Pockettheals'); 
        updateCharacter('Flooknew'); 
        updateCharacter('Vipr'); 
        updateCharacter('Facilitation'); 
        updateCharacter('Wizzykinetic'); 
        updateCharacter('Subduce'); 

        //updateItems();
        //runAllSims();
    }, 5000);

    mailer.log("Bastion Droptimizer server has started")
}

function createCronJobs() {
    // update all characters every hour with new data from battle.net
    cron.schedule('0 * * * *', function() {
        console.log('CRON: Updating Characters');
        updateAllCharacters();
    }, { timezone: 'Australia/Sydney' });

    // start new droptimizer sims at 5:00am every day
    cron.schedule('0 5 * * *', function() {
        console.log('CRON: Running character sims');
        mailer.log('CRON: Running character sims');
        runAllSims();
    }, { timezone: 'Australia/Sydney' });

    // update items at 4:00am every day
    cron.schedule('0 4 * * *', function() {
        console.log('CRON: Updating items');
        mailer.log('CRON: Updating items');
        updateItems();
    }, { timezone: 'Australia/Sydney' });
}

firstStart();

// express routes
router.get('/report/:reportID', function(req, res, next) {
    updateSimcReport(req.params.reportID);
    res.json(`Parsing report with id ${req.params.reportID}`);
});

router.get('/sim/:charName', function(req, res, next) {
    runSim(req.params.charName);
    res.json(`Sim Started for ${req.params.charName}. New upgrades should be ready in 10 minutes.`);
});

router.get('/all/sim$', function(req, res, next) {
    runAllSims();
    res.json(`Sim started for all characters. This could take a while.`);
});

router.get('/character/:charName', function(req, res, next) {
    updateCharacter(req.params.charName);
    res.json(`Character ${req.params.charName} has been updated.`);
});

router.get('/remove/character/:charName', function(req, res, next) {
    removeCharacter(req.params.charName);
    res.json(`Character ${req.params.charName} has been removed.`);
});

router.get('/all/character$', function(req, res, next) {
    updateAllCharacters();
    res.json(`All characters have been updated.`);
});

router.get('/prune$', function(req, res, next) {
    pruneStaleUpgrades();
    res.json(`Pruned stale upgrade data.`);
});

router.get('/generate/report$', function(req, res, next) {
    reportGenerator.generateSubReport();
    res.json(`Compiled and mailed substitution report.`);
});


module.exports = router;
