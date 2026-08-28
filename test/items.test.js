import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {commandFor, parseColor} from '../lib/items.js';

describe('parseColor', () => {
    test('forms', () => {
        assert.deepEqual(parseColor({r: 1, g: 2, b: 3}), {r: 1, g: 2, b: 3});
        assert.deepEqual(parseColor({r: '300', g: -1, b: 3.7}), {r: 255, g: 0, b: 4});
        assert.deepEqual(parseColor('#ff7f00'), {r: 255, g: 127, b: 0});
        assert.deepEqual(parseColor('FF7F00'), {r: 255, g: 127, b: 0});
        assert.deepEqual(parseColor('255,127,0'), {r: 255, g: 127, b: 0});
        assert.deepEqual(parseColor(' 255 127 0 '), {r: 255, g: 127, b: 0});
        assert.deepEqual(parseColor('{"r":1,"g":2,"b":3}'), {r: 1, g: 2, b: 3});
        assert.throws(() => parseColor('red'), /cannot parse/);
        assert.throws(() => parseColor({r: 1}), /needs r, g, b/);
    });
});

describe('commandFor', () => {
    test('power / brightness', () => {
        assert.deepEqual(commandFor('power', 'on'), {type: 'power', on: true});
        assert.deepEqual(commandFor('power', false), {type: 'power', on: false});
        assert.deepEqual(commandFor('power', '0'), {type: 'power', on: false});
        assert.deepEqual(commandFor('brightness', '50'), {type: 'brightness', percent: 50});
        assert.deepEqual(commandFor('brightness', 250), {type: 'brightness', percent: 100});
        assert.deepEqual(commandFor('brightness', 0), {type: 'power', on: false});
        assert.throws(() => commandFor('brightness', 'bright'), /needs a number/);
    });

    test('color / color_temp', () => {
        assert.deepEqual(commandFor('color', '#0000ff'), {type: 'color', color: {r: 0, g: 0, b: 255}});
        assert.deepEqual(commandFor('color_temp', 4000), {type: 'color_temp', kelvin: 4000});
        assert.deepEqual(commandFor('color_temp', 100), {type: 'color_temp', kelvin: 2000});
        assert.deepEqual(commandFor('color_temp', 20000, {colorTemp: {min: 2700, max: 6500}}), {
            type: 'color_temp',
            kelvin: 6500,
        });
        assert.throws(() => commandFor('color_temp', 0), /kelvin/);
    });

    test('scene / music', () => {
        assert.deepEqual(commandFor('scene', 'Sunset Glow'), {type: 'scene', key: 'Sunset Glow', speed: undefined});
        assert.deepEqual(commandFor('scene', 7535), {type: 'scene', key: '7535', speed: undefined});
        assert.deepEqual(commandFor('scene', {name: 'matrix', speed: 150}), {type: 'scene', key: 'matrix', speed: 100});
        assert.deepEqual(commandFor('scene', '{"code": 7517, "speed": 10}'), {type: 'scene', key: '7517', speed: 10});
        assert.throws(() => commandFor('scene', ''), /name or code/);
        assert.throws(() => commandFor('scene', {speed: 1}), /name or code/);
        assert.deepEqual(commandFor('music', ' Rhythm '), {type: 'music', key: 'rhythm'});
        assert.throws(() => commandFor('music', ''), /mode name/);
    });

    test('refresh / raw / unknown', () => {
        assert.deepEqual(commandFor('refresh', ''), {type: 'refresh'});
        assert.throws(() => commandFor('raw', '330101'), /disabled/);
        assert.deepEqual(commandFor('raw', '330101', {rawSet: true}), {type: 'raw', frames: '330101'});
        assert.throws(() => commandFor('volume', 1), /unknown set item/);
    });
});
