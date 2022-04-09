import {
  equippedItem,
  Item,
  Monster,
  monsterDefense,
  myBuffedstat,
  myMp,
  Skill,
  weaponType,
} from "kolmafia";
import { $skill, $slot, getTodaysHolidayWanderers, have, Macro } from "libram";
import {
  BanishSource,
  CombatResource,
  FreekillSource,
  RunawaySource,
  WandererSource,
} from "./resources";

export enum MonsterStrategy {
  Ignore, // Task doesn't care what happens
  IgnoreNoBanish, // Task doesn't care what happens, as long as it is not banished
  Kill, // Task needs to kill it, with or without a free kill
  KillFree, // Task needs to kill it with a free kill
  KillHard, // Task needs to kill it without using a free kill (i.e., boss, or already free)
  Banish, // Task doesn't care what happens, but banishing is useful
  Abort, // Abort the macro and the script; an error has occured
  KillItem, // Kill with an item boost
}

export class CombatResourceAllocation {
  private base = new Map<MonsterStrategy, CombatResource>();

  allocate(strategy: MonsterStrategy, resource?: CombatResource) {
    if (resource === undefined) return;
    this.base.set(strategy, resource);
  }

  // Typed allocation methods for safety
  public banishWith(resource?: BanishSource): void {
    this.allocate(MonsterStrategy.Banish, resource);
  }
  public freekillWith(resource?: FreekillSource): void {
    this.allocate(MonsterStrategy.KillFree, resource);
  }
  public runawayWith(resource?: RunawaySource): void {
    this.allocate(MonsterStrategy.Ignore, resource);
  }
  public runawayNoBanishWith(resource?: RunawaySource): void {
    this.allocate(MonsterStrategy.IgnoreNoBanish, resource);
  }

  public all(): CombatResource[] {
    return Array.from(this.base.values());
  }

  public has(for_strategy: MonsterStrategy) {
    return this.base.has(for_strategy);
  }

  public getMacro(for_strategy: MonsterStrategy): Macro | undefined {
    const resource = this.base.get(for_strategy);
    if (resource === undefined) return undefined;
    if (resource.do instanceof Macro) return resource.do;
    if (resource.do instanceof Item) return new Macro().item(resource.do);
    if (resource.do instanceof Skill) return new Macro().skill(resource.do);
    throw `Unable to convert resource ${resource.name} to a macro`;
  }
}

export class BuiltCombatStrategy {
  macro: Macro = new Macro();
  boss: boolean;
  resources: CombatResourceAllocation;

  constructor(
    abstract: CombatStrategy,
    resources: CombatResourceAllocation,
    wanderers: WandererSource[]
  ) {
    this.boss = abstract.boss;
    this.resources = resources;

    // First, kill wanderers
    for (const wanderer of wanderers) {
      // Note that we kill hard, which never uses up a freekill
      this.macro = this.macro.if_(wanderer.monster, this.prepare_macro(MonsterStrategy.KillHard));
    }

    if (abstract.init_macro) {
      this.macro = this.macro.step(undelay(abstract.init_macro));
    }

    // Second, perform any monster-specific strategies (these may or may not end the fight)
    abstract.macros.forEach((value, key) => {
      this.macro = this.macro.if_(key, new Macro().step(...value.map(undelay)));
    });
    abstract.strategy.forEach((strat, monster) => {
      this.macro = this.macro.if_(monster, this.prepare_macro(strat, monster));
    });

    // Finally, perform the non-monster specific strategies
    if (abstract.default_macro)
      this.macro = this.macro.step(new Macro().step(...abstract.default_macro.map(undelay)));
    this.macro = this.macro.step(this.prepare_macro(abstract.default_strategy));
  }

  prepare_macro(strategy: MonsterStrategy | Macro, monster?: Monster): Macro {
    if (strategy instanceof Macro) return strategy;

    // Upgrade normal kills to free kills if provided
    if (
      strategy === MonsterStrategy.Kill &&
      this.resources.has(MonsterStrategy.KillFree) &&
      !(monster?.boss || this.boss)
    ) {
      strategy = MonsterStrategy.KillFree;
    }

    // Upgrade normal kills to hard kills if we are underleveled
    if (
      strategy === MonsterStrategy.Kill &&
      this.resources.has(MonsterStrategy.KillFree) === undefined &&
      monster &&
      monsterDefense(monster) * 1.25 > myBuffedstat(weaponType(equippedItem($slot`Weapon`)))
    ) {
      strategy = MonsterStrategy.KillHard;
    }

    // Use the appropriate resource if provided
    const use_resource = this.resources.getMacro(strategy);
    if (use_resource !== undefined) return use_resource;

    // Choose a killing blow (items, banish, or stats)
    let killing_blow = undefined;
    if (myMp() >= 20) {
      // eslint-disable-next-line libram/verify-constants
      if (strategy === MonsterStrategy.KillItem && have($skill`Double Nanovision`))
        // eslint-disable-next-line libram/verify-constants
        killing_blow = $skill`Double Nanovision`;
      // eslint-disable-next-line libram/verify-constants
      else if (have($skill`Infinite Loop`)) killing_blow = $skill`Infinite Loop`;
    }

    // Otherwise, default to standard strategies
    switch (strategy) {
      case MonsterStrategy.KillItem:
      case MonsterStrategy.IgnoreNoBanish:
      case MonsterStrategy.Ignore:
      case MonsterStrategy.Kill:
      case MonsterStrategy.KillHard:
      case MonsterStrategy.Banish:
        if ((monster && monster.physicalResistance >= 70) || !killing_blow)
          return new Macro().attack().repeat();
        return new Macro().skill(killing_blow).repeat(); // TODO: get to low HP first?
      // Abort for strategies that can only be done with resources
      case MonsterStrategy.KillFree:
      case MonsterStrategy.Abort:
        return new Macro().abort();
    }
  }
}

export type DelayedMacro = Macro | (() => Macro);

function undelay(macro: DelayedMacro): Macro {
  if (macro instanceof Macro) return macro;
  else return macro();
}

const holidayMonsters = getTodaysHolidayWanderers();

export class CombatStrategy {
  init_macro?: DelayedMacro;
  default_strategy: MonsterStrategy = MonsterStrategy.Ignore;
  default_macro?: DelayedMacro[];
  strategy: Map<Monster, MonsterStrategy> = new Map();
  macros: Map<Monster, DelayedMacro[]> = new Map();
  boss: boolean;

  constructor(boss?: boolean) {
    this.boss = boss ?? false;

    // TODO: better detection of which zones holiday monsters can appear
    if (holidayMonsters.length > 0 && !this.boss) this.ignore(...holidayMonsters);
  }

  apply(strategy: MonsterStrategy, ...monsters: Monster[]): CombatStrategy {
    if (monsters.length === 0) {
      this.default_strategy = strategy;
    }
    for (const monster of monsters) {
      this.strategy.set(monster, strategy);
    }
    return this;
  }
  public kill(...monsters: Monster[]): CombatStrategy {
    return this.apply(MonsterStrategy.Kill, ...monsters);
  }
  public killFree(...monsters: Monster[]): CombatStrategy {
    return this.apply(MonsterStrategy.KillFree, ...monsters);
  }
  public killHard(...monsters: Monster[]): CombatStrategy {
    return this.apply(MonsterStrategy.KillHard, ...monsters);
  }
  public killItem(...monsters: Monster[]): CombatStrategy {
    return this.apply(MonsterStrategy.KillItem, ...monsters);
  }
  public banish(...monsters: Monster[]): CombatStrategy {
    if (monsters.length === 0) throw `Must specify list of monsters to banish`;
    return this.apply(MonsterStrategy.Banish, ...monsters);
  }
  public ignore(...monsters: Monster[]): CombatStrategy {
    return this.apply(MonsterStrategy.Ignore, ...monsters);
  }
  public ignoreNoBanish(...monsters: Monster[]): CombatStrategy {
    return this.apply(MonsterStrategy.IgnoreNoBanish, ...monsters);
  }
  public abort(...monsters: Monster[]): CombatStrategy {
    return this.apply(MonsterStrategy.Abort, ...monsters);
  }
  public macro(strategy: DelayedMacro, ...monsters: Monster[]): CombatStrategy {
    if (monsters.length === 0) {
      if (this.default_macro === undefined) this.default_macro = [];
      this.default_macro.push(strategy);
    }
    for (const monster of monsters) {
      if (!this.macros.has(monster)) this.macros.set(monster, []);
      this.macros.get(monster)?.push(strategy);
    }
    return this;
  }
  public prependMacro(strategy: DelayedMacro, ...monsters: Monster[]): CombatStrategy {
    if (monsters.length === 0) {
      this.init_macro = strategy;
    }
    for (const monster of monsters) {
      if (!this.macros.has(monster)) this.macros.set(monster, []);
      this.macros.get(monster)?.unshift(strategy);
    }
    return this;
  }

  public can(do_this: MonsterStrategy): boolean {
    if (do_this === this.default_strategy) return true;
    return Array.from(this.strategy.values()).includes(do_this);
  }

  public where(do_this: MonsterStrategy): Monster[] {
    return Array.from(this.strategy.keys()).filter((key) => this.strategy.get(key) === do_this);
  }

  public currentStrategy(monster: Monster): MonsterStrategy {
    return this.strategy.get(monster) ?? this.default_strategy;
  }

  public clone(): CombatStrategy {
    const result = new CombatStrategy(this.boss);
    result.default_strategy = this.default_strategy;
    result.default_macro = this.default_macro;
    result.strategy = new Map(this.strategy);
    result.macros = new Map(this.macros);
    return result;
  }
}

export function main(): void {
  Macro.load().submit();
}
