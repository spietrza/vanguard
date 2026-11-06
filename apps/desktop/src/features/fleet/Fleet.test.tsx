import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Fleet } from './Fleet';
import type { BoardTask } from '../../wire';

vi.mock('../../ipc', () => ({
  listSpawns: vi.fn(async () => []),
  listTasks: vi.fn(),
  readAppConfigStrict: vi.fn(async () => ({})),
  spawnRun: vi.fn(),
  killRun: vi.fn(),
  SPAWN_OUTPUT_EVENT: 'spawn:output',
  SPAWN_EXIT_EVENT: 'spawn:exit',
}));
vi.mock('../../transport', () => ({ subscribe: vi.fn(async () => () => {}) }));
import { listTasks, readAppConfigStrict, spawnRun } from '../../ipc';
const mockListTasks = vi.mocked(listTasks);

describe('Fleet watch loop launch — repo config cannot inject', () => {
  test('a provider carrying shell syntax is refused and nothing is spawned', async () => {
    mockListTasks.mockResolvedValue({ tasks: [], capped: false });
    vi.mocked(readAppConfigStrict).mockResolvedValueOnce({ provider: 'claude; touch /tmp/x #' });
    vi.mocked(spawnRun).mockClear();
    render(<Fleet project="/repo" active={[]} />);
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByLabelText('Toggle watch loop')));
    expect(await screen.findByText(/Invalid provider/)).toBeInTheDocument();
    expect(spawnRun).not.toHaveBeenCalled();
  });

  test('a valid config is spawned as an argv, not a shell string', async () => {
    mockListTasks.mockResolvedValue({ tasks: [], capped: false });
    vi.mocked(readAppConfigStrict).mockResolvedValueOnce({ provider: 'codex' });
    vi.mocked(spawnRun).mockClear();
    vi.mocked(spawnRun).mockResolvedValueOnce(7);
    render(<Fleet project="/repo" active={[]} />);
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByLabelText('Toggle watch loop')));
    expect(spawnRun).toHaveBeenCalledWith('/repo', [
      'vanguard', 'watch', '--github', '--concurrency', '3', '--provider', 'codex', '--max-turns', '30',
    ]);
  });
});

function waitingTask(id: string): BoardTask {
  return { id, title: id, column: 'queued', state: 'ready for spec', waiting: true };
}
const WAITING_FOUR: BoardTask[] = ['a', 'b', 'c', 'd'].map(waitingTask);

describe('Fleet slot meter — waiting count (T18–T20)', () => {
  test('T18: Fleet fetches the task list itself on mount — no prior board visit needed', async () => {
    mockListTasks.mockResolvedValue({ tasks: WAITING_FOUR, capped: false });
    render(<Fleet project="/repo" active={[]} />);
    expect(await screen.findByText('Slots 0 / 3 in use · 4 waiting')).toBeInTheDocument();
    expect(mockListTasks).toHaveBeenCalledWith('/repo');
  });

  test('T18b: a capped list makes the count a lower bound', async () => {
    mockListTasks.mockResolvedValue({ tasks: WAITING_FOUR, capped: true });
    render(<Fleet project="/repo" active={[]} />);
    expect(await screen.findByText('Slots 0 / 3 in use · 4+ waiting')).toBeInTheDocument();
  });

  test('T19: while loading, and if the fetch fails, the meter stays bare — never `0`', async () => {
    mockListTasks.mockRejectedValue('boom');
    render(<Fleet project="/repo" active={[]} />);
    expect(screen.getByText('Slots 0 / 3 in use')).toBeInTheDocument(); // still loading
    // Let the rejection settle — asserting before it does would pass against the loading state and
    // never exercise the error branch at all.
    await act(async () => {});
    expect(mockListTasks).toHaveBeenCalled();
    expect(screen.getByText('Slots 0 / 3 in use')).toBeInTheDocument();
    expect(screen.queryByText(/waiting/)).not.toBeInTheDocument();
  });

  test('T20: a fetched zero is a real answer — only an unknown count suppresses', async () => {
    mockListTasks.mockResolvedValue({ tasks: [], capped: false });
    render(<Fleet project="/repo" active={[]} />);
    expect(await screen.findByText('Slots 0 / 3 in use · 0 waiting')).toBeInTheDocument();
  });
});
