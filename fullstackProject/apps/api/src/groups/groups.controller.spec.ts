import { NotFoundException } from '@nestjs/common';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';

describe('GroupsController — REST создания и превью', () => {
  let controller: GroupsController;
  let groups: GroupsService;
  let seatMap: jest.Mock;

  beforeEach(() => {
    groups = new GroupsService();
    groups.now = () => 1_700_000_000_000;
    seatMap = jest.fn(async () => ({
      sessionId: 's-1',
      layout: { rows: 8, seatsPerRow: 10 },
      occupied: [],
      free: 80,
    }));
    controller = new GroupsController(groups, {
      seatMap: seatMap as never,
    } as never);
  });

  it('create: сеанс валиден → код + participantId создателя', async () => {
    const res = await controller.create({ sessionId: 's-1', name: 'Алиса' });
    expect(res.code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(res.state.participants).toHaveLength(1);
    expect(seatMap).toHaveBeenCalledWith('s-1');
  });

  it('create: несуществующий сеанс → ошибка прокидывается (404 фильтром)', async () => {
    seatMap.mockRejectedValue(new NotFoundException('сеанс'));
    await expect(
      controller.create({ sessionId: 's-nope', name: 'Алиса' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('preview: живая группа → её состояние', async () => {
    const created = await controller.create({ sessionId: 's-1', name: 'Алиса' });
    const state = await controller.preview(created.code);
    expect(state.code).toBe(created.code);
    expect(state.participants[0]!.name).toBe('Алиса');
  });

  it('preview: распавшаяся/чужая группа → 404', async () => {
    await expect(controller.preview('ZZZZZZ')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
