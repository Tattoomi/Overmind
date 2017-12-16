// Objective to fortify walls
import {Objective} from './Objective';
import {TaskFortify} from '../tasks/task_fortify';
import {profile} from '../lib/Profiler';


export const fortifyObjectiveName = 'fortify';

@profile
export class ObjectiveFortify extends Objective {
	target: StructureWall | StructureRampart;

	constructor(target: StructureWall | StructureRampart) {
		super(fortifyObjectiveName, target);
		this.assignableToRoles = ['worker'];
		this.maxCreeps = 1;
	}

	assignableTo(creep: ICreep) {
		return this.assignableToRoles.includes(creep.memory.role) &&
			   creep.getActiveBodyparts(WORK) > 0 &&
			   creep.carry.energy > 0;
	}

	getTask() {
		return new TaskFortify(this.target);
	}
}