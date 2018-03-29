import { VariablesProvider } from "./scope";
import { ThreadAdapter } from "./thread";
import { FrameAdapter } from "./frame";
import { VariableAdapter } from "./variable";

export class GetterValueAdapter implements VariablesProvider {

	public readonly variablesProviderId: number;
	public get threadAdapter(): ThreadAdapter {
		return this.variableAdapter.threadAdapter;
	}
	public get referenceExpression(): string | undefined {
		return this.variableAdapter.referenceExpression;
	}
	public get referenceFrame(): FrameAdapter | undefined {
		return this.variableAdapter.referenceFrame;
	}

	public constructor(private readonly variableAdapter: VariableAdapter) {
		this.variablesProviderId = this.threadAdapter.debugSession.variablesProviders.register(this);
	}

	public async getVariables(): Promise<VariableAdapter[]> {
		if (this.referenceExpression && this.referenceFrame) {

			const grip = await this.threadAdapter.coordinator.evaluate(
				this.referenceExpression, this.referenceFrame.frame.actor
			);

			const variableAdapter = VariableAdapter.fromGrip(
				'Value from Getter', this.referenceExpression, this.referenceFrame,
				grip, false, this.threadAdapter, true
			);

			return [ variableAdapter ];

		} else {
			return [];
		}
	}
}
