import { nanoid } from 'nanoid';

export const eventId = () => `evt_${nanoid(16)}`;
export const turnId = () => `turn_${nanoid(16)}`;
export const factId = () => `fact_${nanoid(16)}`;
export const entityId = () => `ent_${nanoid(16)}`;
export const jobId = () => `job_${nanoid(16)}`;
export const convId = () => `conv_${nanoid(16)}`;
