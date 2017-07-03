/*
 * Copyright (C) 2017 Anthony DeDominic <adedomin@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

var GridPaint = require('gridpaint'),
    api = require('../lib/api.js'),
    mooseToGrid = require('../lib/moose-grid').mooseToGrid,
    gridToMoose = require('../lib/moose-grid').gridToMoose,
    sizeInfo = require('../lib/moose-size'),
    colors = require('../lib/color-palette')

function getParameterByName(name) {
    var url = window.location.href
    name = name.replace(/[[]]/g, '\\$&')
    var regex = new RegExp(`[?&]${name}(=([^&#]*)|&|#|$)`),
        results = regex.exec(url)
    if (!results) return null
    if (!results[2]) return ''
    return decodeURIComponent(results[2].replace(/\+/g, ' '))
}

module.exports = function(state, emitter) {
    state.title = {
        msg: 'Make a Moose today',
        status: 'primary',
    }

    state.moose = {
        name: '',
        hd: false,
    }

    var newPainter = () => {
        state.painter = new GridPaint({
            width: 
                state.moose.hd ? 
                sizeInfo.hd.width :
                sizeInfo.normal.width, 
            height: 
                state.moose.hd ?
                sizeInfo.hd.height :
                sizeInfo.normal.height,
            cellWidth: 16,
            cellHeight: 24,
            palette: colors.fullPallete,
        }) 
        state.painter.tool = 'pencil'
        state.painter.color = 1
        state.painter.colour = 'transparent'
        state.painter.grid = true
        state.painter.shade = 3
    }

    var destoryPainter = () => {
        state.painter.destroy()
        if (state.painter.dom) {
            state.painter.dom
                .parentNode
                .removeChild(
                    state.painter.dom
                )
        }
    }

    newPainter()
    state.tools = [ 
        'pencil', 
        'bucket', 
        'grid',
        'undo', 
        'redo', 
        'hd/sd',
        'clear',
    ]

    emitter.on('shader-select', (shade) => {
        state.painter.shade = shade
        emitter.emit('render')
    })

    emitter.on('color-select', (color) => {
        state.painter.colour = color
        console.log(color, state.painter.palette[color])
        emitter.emit('render')
    })

    emitter.on('tool-select', (action) => {
        if (action == 'pencil' || action == 'bucket') {
            state.painter.tool = action
        }
        else if (action == 'grid') {
            state.painter.grid = !state.painter.grid
        }
        else if (action == 'hd/sd') {
            state.moose.hd = !state.moose.hd
            destoryPainter()
            var temp = state.painter.painting
            // resize image for new canvas
            if (state.moose.hd) {
                temp = temp.concat(Array.from({
                    length: sizeInfo.hd.height - temp.length,
                }).fill([]))
                temp.forEach((arr, i) => {
                    temp[i] = arr.concat(Array.from({
                        length: sizeInfo.hd.width - arr.length,
                    }, () => 0))
                })
            }
            else {
                temp.splice(
                    sizeInfo.normal.height,
                    temp.length - sizeInfo.normal.height
                )
                temp.forEach(arr => {
                    arr.splice(
                        sizeInfo.normal.width,
                        arr.length - sizeInfo.normal.width
                    )
                })
            }
            newPainter()
            state.painter.painting = temp
            state.painter.init()
        }
        else {
            state.painter[action]()
        }
        emitter.emit('render')
    })

    emitter.on('moose-name-change', (name) => {
        state.moose.name = name
    })

    emitter.on('moose-save', () => {
        state.moose.image = gridToMoose(state.painter.painting)
        api.saveMoose(state.moose, (err, body) => {
            if (err || !body || body.status == 'error') {
                if (!body) body = { 
                    msg: err.toString() || 'unknown error',
                }
                if (typeof body.msg == 'object') 
                    body.msg = JSON.stringify(body.msg)
                state.title.msg = 
                    `failed to save moose: ${body.msg}`
                state.title.status = 'danger'
            }
            else {
                state.title.msg = body.msg
                state.title.status = 'success'
            }
             
            emitter.emit('render')
        })
    })

    emitter.on('moose-edit', (editmoose) => {
        state.moose.name = editmoose || ''
        state.title.msg = `editing ${editmoose}...`
        api.getMoose(editmoose, (err, body) => {
            if (!err && body && body.image) {
                // not all moose have the hd field
                // this will convert undefined/null
                // to false
                body.hd = !!body.hd
                if (state.moose.hd != body.hd) {
                    state.moose.hd = body.hd
                    destoryPainter()
                    newPainter()
                    state.painter.init()
                }
                state.painter.painting = 
                    mooseToGrid(body.image)
            }
            emitter.emit('render')
        })
    })

    emitter.on('pushState', () => {
        if (getParameterByName('edit')) 
            emitter.emit('moose-edit', getParameterByName('edit'))
    })

    state.painter.init()
    if (getParameterByName('edit')) 
        emitter.emit('moose-edit', getParameterByName('edit'))
}
