import {Overlord} from '../Overlord';
import {Zerg} from '../../zerg/Zerg';
import {Tasks} from '../../tasks/Tasks';
import {Colony, ColonyStage} from '../../Colony';
import {ALL_RESOURCE_TYPE_ERROR, BufferTarget, LogisticsRequest} from '../../logistics/LogisticsNetwork';
import {OverlordPriority} from '../../priorities/priorities_overlords';
import {Pathing} from '../../movement/Pathing';
import {profile} from '../../profiler/decorator';
import {isResource, isStoreStructure, isTombstone} from '../../declarations/typeGuards';
import {log} from '../../console/log';
import {Roles, Setups} from '../../creepSetups/setups';


@profile
export class TransportOverlord extends Overlord {

	transporters: Zerg[];

	constructor(colony: Colony, priority = OverlordPriority.ownedRoom.transport) {
		super(colony, 'logistics', priority);
		this.transporters = this.zerg(Roles.transport);
	}

	private neededTransportPower(): number {

		if (!this.colony.storage
			&& !(this.colony.hatchery && this.colony.hatchery.battery)
			&& !this.colony.upgradeSite.battery) {
			return 0;
		}

		let transportPower = 0;
		const scaling = 2; // this.colony.stage == ColonyStage.Larva ? 1.5 : 2.0; // aggregate round-trip multiplier

		// Add contributions to transport power from hauling energy from mining sites
		for (let flagName in this.colony.miningSites) {
			const o = this.colony.miningSites[flagName].overlords.mine;
			if (!o.isSuspended && o.miners.length > 0) {
				// Only count sites which have a container output and which have at least one miner present
				// (this helps in difficult "rebooting" situations)
				if ((o.container && !o.link) || o.allowDropMining) {
					transportPower += o.energyPerTick * scaling * o.distance;
				}
			}
		}

		// Add transport power needed to move to upgradeSite
		if (this.colony.upgradeSite.battery) {
			transportPower += UPGRADE_CONTROLLER_POWER * this.colony.upgradeSite.upgradePowerNeeded * scaling *
							  Pathing.distance(this.colony.pos, this.colony.upgradeSite.battery.pos);
		}


		if (this.colony.lowPowerMode) {
			// Reduce needed transporters when colony is in low power mode
			transportPower *= 0.5;
		}

		return transportPower / CARRY_CAPACITY;
	}

	init() {
		let setup = this.colony.stage == ColonyStage.Larva ? Setups.transporters.early : Setups.transporters.default;
		let transportPowerEach = setup.getBodyPotential(CARRY, this.colony);
		let neededTransportPower = this.neededTransportPower();
		let numTransporters = Math.ceil(neededTransportPower / transportPowerEach);
		if (this.transporters.length == 0) {
			this.wishlist(numTransporters, setup, {priority: OverlordPriority.ownedRoom.firstTransport});
		} else {
			this.wishlist(numTransporters, setup);
		}
	}

	private handleTransporter(transporter: Zerg, request: LogisticsRequest | undefined) {
		if (request) {
			let choices = this.colony.logisticsNetwork.bufferChoices(transporter, request);
			let bestChoice = _.last(_.sortBy(choices, choice => request.multiplier * choice.dQ
																/ Math.max(choice.dt, 0.1)));
			let task = null;
			let amount = this.colony.logisticsNetwork.predictedRequestAmount(transporter, request);
			// Target is requesting input
			if (amount > 0) {
				if (isResource(request.target) || isTombstone(request.target)) {
					log.warning(`Improper logistics request: should not request input for resource or tombstone!`);
					return;
				} else if (request.resourceType == 'all') {
					log.error(`TransportOverlord: ` + ALL_RESOURCE_TYPE_ERROR);
					return;
				} else {
					task = Tasks.transfer(request.target, request.resourceType);
				}
				if (bestChoice.targetRef != request.target.ref) {
					// If we need to go to a buffer first to get more stuff
					let buffer = deref(bestChoice.targetRef) as BufferTarget;
					let withdrawAmount = Math.min(buffer.store[request.resourceType] || 0,
												  transporter.carryCapacity - _.sum(transporter.carry), amount);
					task = task.fork(Tasks.withdraw(buffer, request.resourceType, withdrawAmount));
					if (transporter.hasMineralsInCarry && request.resourceType == RESOURCE_ENERGY) {
						task = task.fork(Tasks.transferAll(buffer));
					}
				}
			}
			// Target is requesting output
			else if (amount < 0) {
				if (isResource(request.target)) {
					task = Tasks.pickup(request.target);
				} else {
					if (request.resourceType == 'all') {
						if (!isStoreStructure(request.target) && !isTombstone(request.target)) {
							log.error(`TransportOverlord: ` + ALL_RESOURCE_TYPE_ERROR);
							return;
						}
						task = Tasks.withdrawAll(request.target);
					} else {
						task = Tasks.withdraw(request.target, request.resourceType);
					}
				}
				if (task && bestChoice.targetRef != request.target.ref) {
					// If we need to go to a buffer first to deposit stuff
					let buffer = deref(bestChoice.targetRef) as BufferTarget;
					task = task.fork(Tasks.transferAll(buffer));
				}
			} else {
				// console.log(`${transporter.name} chooses a store with 0 amount!`);
				transporter.park();
			}
			// Assign the task to the transporter
			transporter.task = task;
			this.colony.logisticsNetwork.invalidateCache(transporter, request);
		} else {
			// If nothing to do, put everything in a store structure
			if (_.sum(transporter.carry) > 0) {
				let dropoffPoints: (StructureLink | StructureStorage)[] = _.compact([this.colony.storage!]);//, ...this.colony.dropoffLinks]);
				// let bestDropoffPoint = minBy(dropoffPoints, function(dropoff: StructureLink | StructureStorage) {
				// 	let range = transporter.pos.getMultiRoomRangeTo(dropoff.pos);
				// 	if (dropoff instanceof StructureLink) {
				// 		return Math.max(range, this.colony.linkNetwork.getDropoffAvailability(dropoff));
				// 	} else {
				// 		return range;
				// 	}
				// });
				let nonzeroResources = _.filter(_.keys(transporter.carry),
												(key: ResourceConstant) => (transporter.carry[key] || 0) > 0);
				if (nonzeroResources.length > 1) {
					if (this.colony.storage) {
						transporter.task = Tasks.transferAll(this.colony.storage);
					}
				}
				else {
					let bestDropoffPoint = transporter.pos.findClosestByMultiRoomRange(dropoffPoints);

					if (bestDropoffPoint) transporter.task = Tasks.transfer(bestDropoffPoint);
				}
			} else {
				let parkingSpot = transporter.pos;
				if (this.colony.storage) {
					parkingSpot = this.colony.storage.pos;
				} else if (this.colony.roomPlanner.storagePos) {
					parkingSpot = this.colony.roomPlanner.storagePos;
				}
				transporter.park(parkingSpot);
			}
		}
		//console.log(JSON.stringify(transporter.memory.task));
	}

	private handleBigTransporter(bigTransporter: Zerg) {
		let bestRequestViaStableMatching = this.colony.logisticsNetwork.matching[bigTransporter.name];
		this.handleTransporter(bigTransporter, bestRequestViaStableMatching);
	}

	/* Handles small transporters, which don't do well with the logisticsNetwork's stable matching system */
	private handleSmolTransporter(smolTransporter: Zerg) {
		// Just perform a single-sided greedy selection of all requests
		let bestRequestViaGreedy = _.first(this.colony.logisticsNetwork.transporterPreferences(smolTransporter));
		this.handleTransporter(smolTransporter, bestRequestViaGreedy);
	}

	private pickupDroppedResources(transporter: Zerg) {
		let droppedResource = transporter.pos.lookFor(LOOK_RESOURCES)[0];
		if (droppedResource) {
			transporter.pickup(droppedResource);
			return;
		}
		let tombstone = transporter.pos.lookFor(LOOK_TOMBSTONES)[0];
		if (tombstone) {
			let resourceType = _.last(_.sortBy(_.keys(tombstone.store),
											   resourceType => (tombstone.store[<ResourceConstant>resourceType] || 0)));
			transporter.withdraw(tombstone, <ResourceConstant>resourceType);
		}
	}

	run() {
		this.autoRun(this.transporters, transporter => this.handleSmolTransporter(transporter));
	}
}
