import type {Engine} from '../types.ts';
import {designEngine} from './design.ts';
import {falImageEngine} from './fal-image.ts';
import {motionEngine} from './motion.ts';
import {videoEngine} from './video.ts';
import {voiceEngine} from './voice.ts';

export const ENGINES: readonly Engine[] = [
	designEngine as Engine,
	voiceEngine as Engine,
	videoEngine as Engine,
	motionEngine as Engine,
	falImageEngine as Engine,
];

export function findEngine(id: string): Engine | undefined {
	return ENGINES.find(engine => engine.id === id);
}
