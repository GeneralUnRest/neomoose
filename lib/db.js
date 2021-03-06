/*
 * Copyright (C) 2020  Anthony DeDominic <adedomin@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */


'use strict';
const sqlite3 = require('better-sqlite3');
const { SqliteError } = sqlite3;
const { Readable } = require('stream');
const logger = require('./logger');

/**
 * A Moose
 * @typedef {object} Moose
 * @property {string} name
 * @property {Date} created
 * @property {string} image
 * @property {string} shade
 * @property {boolean} hd - is large
 * @property {boolean} shaded - is shaded (uses block drawing)
 * @property {boolean} extended - is 82 color
 */

/**
 * The Database Row representation of a Moose
 * @typedef {object} MooseRow
 * @property {string} name
 * @property {number} created - unix time stamp
 * @property {string} image
 * @property {string} shade
 * @property {(0|1)} hd - is larger
 * @property {(0|1)} shaded - has shade
 * @property {(0|1)} extended - 82 color pallete
 */

/**
 * Convert a MooseRow to Moose
 * @param {(MooseRow|undefined)} row - database row
 * @return {(Moose|undefined)} The Moose or undefined if no rows returned.
 */
function rowToMoose(row) {
    if (row === undefined) return;
    /** @type {Moose} */
    return {
        name: row.name,
        image: row.image,
        shade: row.shade,
        created: new Date(row.created),
        hd: !!row.hd,
        shaded: !!row.shaded,
        extended: !!row.extended,
    };
}

/**
 * Convert a Moose to MooseRow
 * @param {Moose} moose
 * @return {MooseRow}
 */
function mooseToRow(moose) {
    return {
        name: moose.name ?? null,
        created: isNaN(+moose.created) ? null : +moose.created,
        image: moose.image ?? null,
        shade: moose.shade ?? '',
        hd: moose.hd ? 1 : 0,
        shaded: moose.shaded ? 1 : 0,
        extended: moose.extended ? 1 : 0,
    };
}

/**
 * Make sure int is an integer
 * @param {number} val
 * @return {boolean} if val is an integer
 */
function notInt(val) {
    return (
        isNaN(val) ||
        !isFinite(val) ||
        !Number.isInteger(val)
    );
}

/**
 * A Readable json dump of a Moose database.
 */
class MooseReadable extends Readable {
    /**
       @param {IterableIterator<Moose>} iterator - selector returning all meese.
    */
    constructor(iterator) {
        super();
        this.iter = iterator;
        this.push('[', 'utf8');
        this.first = true;
    }
    _read() {
        try {
            const { value, done } = this.iter.next();
            const mooseJson = JSON.stringify(rowToMoose(value));
            if (done) {
                this.push(']', 'utf8');
                this.push(null);
            }
            else if (!this.first) {
                this.push(','+mooseJson, 'utf8');
            }
            else {
                this.push(mooseJson, 'utf8');
                this.first = false;
            }
        }
        catch (e) {
            this.destroy(e);
        }

    }
    /**
       Early return iterable and kill stream.
       @param {Error} err
       @param {(err: Error) => void} cb
    */
    _destroy(err, cb) {
        this.iter.return();
        cb(err);
    }
}

class MooseDB {
    /**
       Open and initialize the database schema and define prepared queries.
       @param {string} path - path to the database file.
    */
    constructor(path) {
        this.db = new sqlite3(path);
        this.db.exec(`
            PRAGMA journal_mode=WAL;

            CREATE TABLE IF NOT EXISTS Moose (
                name TEXT PRIMARY KEY NOT NULL,
                created INTEGER NOT NULL,
                image TEXT NOT NULL,
                shade TEXT,
                hd INTEGER,
                shaded INTEGER,
                extended INTEGER,
                png BLOB
            );
            CREATE UNIQUE INDEX IF NOT EXISTS Moose_NameIdx ON Moose (name);
            CREATE INDEX IF NOT EXISTS Moose_CreatedIdx ON Moose (created);

            CREATE VIRTUAL TABLE IF NOT EXISTS MooseSearch USING fts5(
                moose_name, tokenize = 'porter unicode61'
            );

            CREATE TRIGGER IF NOT EXISTS Moose_DelTrigger AFTER DELETE ON Moose
            BEGIN
                DELETE FROM MooseSearch WHERE moose_name = OLD.name;
                -- Allows us to preserve our random Moose query. We don't use this value for pagination.
                UPDATE MOOSE SET rowid = OLD.rowid WHERE rowid = ( Select max(rowid) FROM Moose );
            END;

            CREATE TRIGGER IF NOT EXISTS Moose_InsertTrigger AFTER INSERT ON Moose
            BEGIN
                INSERT INTO MooseSearch(moose_name) VALUES (NEW.name);
            END;
        `);
        this.getMooseByNameStmt = this.db.prepare('SELECT name, created, image, shade, hd, shaded, extended FROM Moose WHERE name = ?');
        // This query has modulo bias.
        this.getRandomMooseStmt = this.db.prepare(`
            SELECT name, created, image, shade, hd, shaded, extended
            FROM Moose
            WHERE rowid = (
                (ABS(RANDOM())) % (SELECT max(rowid) FROM Moose) + 1
            )
        `);
        this.getLatestMooseStmt = this.db.prepare(`
            SELECT name, created, image, shade, hd, shaded, extended
            FROM Moose
            WHERE created = (
                SELECT max(created) FROM Moose
            )
        `);
        this.getOldestMooseStmt = this.db.prepare(`
            SELECT name, created, image, shade, hd, shaded, extended
            FROM Moose
            WHERE created = (
                SELECT min(created) FROM Moose
            )
        `);
        this.dumpDbStmt = this.db.prepare('SELECT name, created, image, shade, hd, shaded, extended FROM Moose');
        this.saveMooseStmt = this.db.prepare(`
            INSERT INTO Moose(
                name,
                created,
                image,
                shade,
                hd,
                shaded,
                extended
            ) VALUES (
                $name,
                $created,
                $image,
                $shade,
                $hd,
                $shaded,
                $extended
            )
        `);
        this.deleteMooseStmt = this.db.prepare('DELETE FROM Moose WHERE name = ?');
        this.getMoosePngStmt = this.db.prepare('SELECT png FROM Moose WHERE name = ?');
        this.saveMoosePngStmt = this.db.prepare('UPDATE Moose SET png = $png WHERE name = $name');
    }
    /**
     * Return one moose for a given exact name
     * @param {string} name
     * @return {Moose}
     */
    getMooseByName(name) {
        return rowToMoose(this.getMooseByNameStmt.get(name));
    }
    /**
     * Returns a single gallary page of moose.
     * Gallery Page is also used for searching for moose.
     * @param {string} query - the query string for moose search. '' == normal pagination.
     * @param {number} offset - page number * page size
     * @param {number} limit - size of the page
     * @param {("newest"|"oldest")} order - what direction to sort by.
     * @return {Array<Moose>}
     */
    getGalleryPage(query, offset, limit, order) {
        /** @type {('ASC'|'DESC')} */
        let newOrder = 'DESC';
        if (order === 'oldest') newOrder = 'ASC';

        if (notInt(+offset) || notInt(+limit)) {
            throw TypeError('offset or limit is not a number');
        }

        if (query !== '') {
            return this._findMooseByQuery(query, offset, limit, newOrder);
        }
        else {
            return this.db.prepare(`
                SELECT name, created, image, shade, hd, shaded, extended
                FROM Moose
                ORDER BY created ${newOrder}
                LIMIT ${+offset}, ${+limit}
            `).all().map(rowToMoose);
        }
    }
    /**
     * Returns search results for moose, specificaly if query is not ''.
     * @param {string} query - the query string for moose search. '' == normal pagination.
     * @param {number} offset - page number * page size
     * @param {number} limit - size of the page
     * @param {("ASC"|"DESC")} order - what direction to sort by (sqlite3 syntax).
     * @return {Array<Moose>}
     */
    _findMooseByQuery(query, offset, limit, order) {
        // escape strange query features in FTS5
        const newQ = query.split(/\s+/).map((word, ind, arr) => {
            if ((word === 'AND' || word === 'OR') && ind !== (arr.length-1)) {
                return word;
            }
            return `"${word.replace(/"/g, '""')}"`;
        }).join(' ');

        return this.db.prepare(`
            SELECT name, created, image, shade, hd, shaded, extended
            FROM Moose
            INNER JOIN (
              SELECT moose_name FROM MooseSearch
              WHERE moose_name MATCH ?
              ORDER BY RANK
            )
            ON name == moose_name
            ORDER BY created ${order}
            LIMIT ${+offset}, ${+limit}
        `).all(newQ).map(rowToMoose);
    }
    /** @return {Moose} */
    getRandomMoose() {
        return rowToMoose(this.getRandomMooseStmt.get());
    }
    /**
     * Get the newest Moose (by Moose.created).
     * @return {Moose}
     */
    getLatestMoose() {
        return rowToMoose(this.getLatestMooseStmt.get());
    }
    /**
     * Get the oldest Moose (by Moose.created).
     * @return {Moose}
     */
    getOldestMoose() {
        return rowToMoose(this.getOldestMooseStmt.get());
    }
    /** @param {Moose} moose - moose to save. */
    saveMoose(moose) {
        return this.saveMooseStmt.run(mooseToRow(moose));
    }
    /**
     * Save large number of Meese in one transaction.
     * @param {Array<Moose>} meese
     * @return {void}
     */
    bulkSaveMoose(meese) {
        const tx = this.db.transaction((meese) => {
            for (const moose of meese) {
                try {
                    this.saveMooseStmt.run(mooseToRow(moose));
                }
                catch (e) {
                    // Ignore moose already in the db.
                    if ((e instanceof SqliteError) &&
                        e.message === 'UNIQUE constraint failed: Moose.name'
                    ) {
                        logger.warn(`BULK IMPORT MOOSE ALREADY EXISTS ${moose.name}`);
                        continue;
                    }
                    else {
                        throw e;
                    }
                }
            }
        });
        return tx(meese);
    }
    /**
     * @param {string} moose - name of the moose
     * @return {(Buffer|undefined)} a png of the moose.
     */
    getMoosePng(moose) {
        return this.getMoosePngStmt.get(moose)?.png;
    }
    /**
     * @param {string} name - moose name
     * @param {Buffer} png - the moose png to save
     */
    saveMoosePng(name, png) {
        return this.saveMoosePngStmt.run({ name, png });
    }
    /** @param {string} moosename */
    deleteMoose(moosename) {
        return this.deleteMooseStmt.run(moosename);
    }
    /** @yields {Moose} */
    [Symbol.iterator]() {
        return this.dumpDbStmt.iterate();
    }
    /** @return {MooseReadable} Stream of all moose as a serialized json array. */
    reader() {
        return new MooseReadable(this.dumpDbStmt.iterate());
    }
}

module.exports = MooseDB;
